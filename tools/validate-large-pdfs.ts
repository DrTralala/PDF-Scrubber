import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export interface ExternalPdfFixture {
  readonly id: string;
  readonly fileName: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  readonly expectation: 'must-render' | 'render-or-named-limit';
}

export const EXTERNAL_PDF_FIXTURES: readonly ExternalPdfFixture[] = [
  {
    id: 'nasa-crs-7',
    fileName: 'nasa-crs-7.pdf',
    url: 'https://www.nasa.gov/wp-content/uploads/2018/07/spacex_nasa_crs-7_presskit.pdf',
    size: 4_668_299,
    sha256: 'b63cd92c8f19193ebc55a327222d2f5a61352342f2f5bc00c6052e4eadb23a8a',
    expectation: 'must-render',
  },
  {
    id: 'nist-sp-800-53r5',
    fileName: 'nist-sp-800-53r5.pdf',
    url: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf',
    size: 6_073_678,
    sha256: 'fc63bcd61715d0181dd8e85998b1e6201ae3515fc6626102101cab1841e11ec6',
    expectation: 'render-or-named-limit',
  },
  {
    id: 'postgresql-17-a4',
    fileName: 'postgresql-17-a4.pdf',
    url: 'https://www.postgresql.org/files/documentation/pdf/17/postgresql-17-A4.pdf',
    size: 15_435_019,
    sha256: '373847948d91630e85dfd80d54a9929920e666575a4a2a276e081480fd0b4ff1',
    expectation: 'render-or-named-limit',
  },
] as const;

export interface LargePdfValidationDependencies {
  readonly fetch: typeof fetch;
  readonly createTemporaryDirectory: () => Promise<string>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly runPlaywright: (directory: string) => Promise<void>;
  readonly removeDirectory: (directory: string) => Promise<void>;
}

export function verifyExternalPdf(
  bytes: Uint8Array,
  fixture: ExternalPdfFixture,
): void {
  if (bytes.byteLength !== fixture.size) {
    throw new Error(
      `${fixture.id} size mismatch: expected ${fixture.size} bytes, received ${bytes.byteLength}`,
    );
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error(`${fixture.id} is missing a %PDF- signature`);
  }
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== fixture.sha256) {
    throw new Error(`${fixture.id} SHA-256 mismatch`);
  }
}

export async function runLargePdfValidation(
  fixtures: readonly ExternalPdfFixture[],
  dependencies: LargePdfValidationDependencies,
): Promise<void> {
  const directory = await dependencies.createTemporaryDirectory();
  try {
    for (const fixture of fixtures) {
      const response = await dependencies.fetch(fixture.url);
      if (!response.ok) {
        throw new Error(`${fixture.id} download failed with HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      verifyExternalPdf(bytes, fixture);
      await dependencies.writeFile(join(directory, fixture.fileName), bytes);
    }
    await dependencies.runPlaywright(directory);
  } finally {
    await dependencies.removeDirectory(directory);
  }
}

async function runPlaywright(directory: string): Promise<void> {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      executable,
      ['run', 'test:web', '--', 'external-large-pdfs.spec.ts'],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: { ...process.env, PDF_SCRUBBER_EXTERNAL_PDF_DIR: directory },
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        signal === null
          ? `Playwright exited with code ${code ?? 'unknown'}`
          : `Playwright exited after signal ${signal}`,
      ));
    });
  });
}

const DEFAULT_DEPENDENCIES: LargePdfValidationDependencies = {
  fetch,
  createTemporaryDirectory: () => mkdtemp(join(tmpdir(), 'pdf-scrubber-large-pdfs-')),
  writeFile: (path, bytes) => writeFile(path, bytes),
  runPlaywright,
  removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
};

const entryPath = process.argv[1];
if (
  entryPath !== undefined
  && pathToFileURL(resolve(entryPath)).href === import.meta.url
) {
  runLargePdfValidation(EXTERNAL_PDF_FIXTURES, DEFAULT_DEPENDENCIES).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Large-PDF validation failed');
    process.exitCode = 1;
  });
}

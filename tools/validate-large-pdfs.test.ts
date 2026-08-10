import { describe, expect, test, vi } from 'vitest';

import {
  runLargePdfValidation,
  verifyExternalPdf,
  type ExternalPdfFixture,
  type LargePdfValidationDependencies,
} from './validate-large-pdfs';

const VALID_BYTES = new TextEncoder().encode('%PDF-1.7\nabc');
const VALID_FIXTURE: ExternalPdfFixture = {
  id: 'verified-test',
  fileName: 'verified-test.pdf',
  url: 'https://example.test/verified-test.pdf',
  size: 12,
  sha256: '3c1dd4f09e8ea551683a8c93d934c49084c2407fe2213a20d2702bad0296be10',
  expectation: 'must-render',
};

function response(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice().buffer, { status });
}

function dependencies(overrides: Partial<LargePdfValidationDependencies> = {}) {
  return {
    fetch: vi.fn(async () => response(VALID_BYTES)),
    createTemporaryDirectory: vi.fn(async () => '/tmp/pdf-scrubber-large-pdfs-test'),
    writeFile: vi.fn(async () => undefined),
    runPlaywright: vi.fn(async () => undefined),
    removeDirectory: vi.fn(async () => undefined),
    ...overrides,
  } satisfies LargePdfValidationDependencies;
}

describe('verifyExternalPdf', () => {
  test('rejects a download whose byte count differs from the pinned fixture', () => {
    expect(() => verifyExternalPdf(VALID_BYTES.subarray(0, 11), VALID_FIXTURE)).toThrow(
      'verified-test size mismatch: expected 12 bytes, received 11',
    );
  });

  test('rejects a download whose SHA-256 differs from the pinned fixture', () => {
    const changed = VALID_BYTES.slice();
    changed[11] = 'd'.charCodeAt(0);

    expect(() => verifyExternalPdf(changed, VALID_FIXTURE)).toThrow(
      'verified-test SHA-256 mismatch',
    );
  });

  test('rejects a download without a PDF signature before writing it', () => {
    const fixture = {
      ...VALID_FIXTURE,
      size: 12,
      sha256: 'a0b3f8190ca6d15a4b3690b97a3a9f0b9f2c5dbb2887788dc3e566890d947075',
    };

    expect(() => verifyExternalPdf(new TextEncoder().encode('not-a-pdf!!!'), fixture)).toThrow(
      'verified-test is missing a %PDF- signature',
    );
  });
});

describe('runLargePdfValidation', () => {
  test('downloads, verifies, writes, and runs the dedicated browser test', async () => {
    const deps = dependencies();

    await runLargePdfValidation([VALID_FIXTURE], deps);

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/pdf-scrubber-large-pdfs-test/verified-test.pdf',
      VALID_BYTES,
    );
    expect(deps.runPlaywright).toHaveBeenCalledWith('/tmp/pdf-scrubber-large-pdfs-test');
    expect(deps.removeDirectory).toHaveBeenCalledWith('/tmp/pdf-scrubber-large-pdfs-test');
  });

  test('cleans the temporary directory when verification fails', async () => {
    const deps = dependencies({
      fetch: vi.fn(async () => response(VALID_BYTES.subarray(0, 11))),
    });

    await expect(runLargePdfValidation([VALID_FIXTURE], deps)).rejects.toThrow(
      'verified-test size mismatch',
    );
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.runPlaywright).not.toHaveBeenCalled();
    expect(deps.removeDirectory).toHaveBeenCalledWith('/tmp/pdf-scrubber-large-pdfs-test');
  });

  test('cleans the temporary directory when the browser test fails', async () => {
    const deps = dependencies({
      runPlaywright: vi.fn(async () => {
        throw new Error('Playwright exited with code 1');
      }),
    });

    await expect(runLargePdfValidation([VALID_FIXTURE], deps)).rejects.toThrow(
      'Playwright exited with code 1',
    );
    expect(deps.removeDirectory).toHaveBeenCalledWith('/tmp/pdf-scrubber-large-pdfs-test');
  });

  test('reports an HTTP failure and still cleans the temporary directory', async () => {
    const deps = dependencies({
      fetch: vi.fn(async () => response(new Uint8Array(), 404)),
    });

    await expect(runLargePdfValidation([VALID_FIXTURE], deps)).rejects.toThrow(
      'verified-test download failed with HTTP 404',
    );
    expect(deps.removeDirectory).toHaveBeenCalledWith('/tmp/pdf-scrubber-large-pdfs-test');
  });
});

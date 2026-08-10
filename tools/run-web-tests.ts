import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type WebTestMode = 'routine' | 'full';

export type WebTestRunnerDependencies = Readonly<{
  launch(arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<number>;
}>;

export type WebTestChild = Pick<ChildProcess, 'once'>;

export type WebTestSpawn = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => WebTestChild;

const requireFromModule = createRequire(import.meta.url);
const PLAYWRIGHT_CLI_PATH = requireFromModule.resolve('@playwright/test/cli');

export function parseWebTestArguments(argv: readonly string[]): Readonly<{
  mode: WebTestMode;
  playwrightArguments: readonly string[];
}> {
  const fullCount = argv.filter((argument) => argument === '--full').length;
  if (fullCount > 1) throw new Error('--full may be supplied only once');
  return Object.freeze({
    mode: fullCount === 1 ? 'full' : 'routine',
    playwrightArguments: Object.freeze(argv.filter((argument) => argument !== '--full')),
  });
}

const defaultSpawn: WebTestSpawn = (executable, arguments_, options) => (
  spawn(executable, [...arguments_], options)
);

export function launchPlaywright(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  spawnImplementation: WebTestSpawn = defaultSpawn,
): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    let settled = false;

    const resolveOnce = (status: number): void => {
      if (settled) return;
      settled = true;
      resolvePromise(status);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    let child: WebTestChild;
    try {
      child = spawnImplementation(process.execPath, [PLAYWRIGHT_CLI_PATH, ...arguments_], {
        cwd: resolve(import.meta.dirname, '..'),
        env: environment,
        shell: false,
        stdio: 'inherit',
      });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    child.once('error', rejectOnce);
    child.once('close', (status, signal) => {
      if (status !== null) {
        resolveOnce(status);
      } else if (signal !== null) {
        rejectOnce(new Error(`Playwright terminated by ${signal}`));
      } else {
        rejectOnce(new Error('Playwright exited with null status'));
      }
    });
  });
}

const DEFAULT_DEPENDENCIES: WebTestRunnerDependencies = Object.freeze({
  launch: launchPlaywright,
});

export async function runWebTests(
  argv: readonly string[],
  dependencies: WebTestRunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const parsed = parseWebTestArguments(argv);
  const playwrightArguments = [
    'test',
    '--config',
    'apps/web/playwright.config.ts',
    ...parsed.playwrightArguments,
  ];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PDF_SCRUBBER_COMMITTED_PDF_MODE: parsed.mode,
  };
  return dependencies.launch(playwrightArguments, environment);
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runWebTests(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main();
}

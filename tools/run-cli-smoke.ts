import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildInstalledCliCommand,
  buildNpmCommand,
  cleanupCliSmoke,
  npmCliPathForRuntime,
  waitForReadiness,
} from './cli-smoke';

const projectRoot = resolve(import.meta.dirname, '..');
const disposableRoot = resolve(tmpdir(), 'opencode');
const requireFromModule = createRequire(import.meta.url);
const playwrightPath = requireFromModule.resolve('@playwright/test/cli');
const npmRuntime = {
  nodeExecutable: process.execPath,
  npmCliPath: npmCliPathForRuntime(process.execPath, process.platform),
};

await mkdir(disposableRoot, { recursive: true });
const temporaryRoot = await mkdtemp(resolve(disposableRoot, 'pdf-scrubber-cli-smoke-'));
let cliChild: ChildProcess | undefined;
let readinessUrl: string | undefined;

try {
  const packCommand = buildNpmCommand(
    ['pack', '--workspace', 'pdf-scrubber', '--pack-destination', temporaryRoot],
    npmRuntime,
  );
  execFileSync(packCommand.executable, [...packCommand.arguments], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  const tarballs = (await readdir(temporaryRoot)).filter((path) => path.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`Expected one tarball, found ${tarballs.length}`);
  const [tarball] = tarballs;
  if (tarball === undefined) throw new Error('npm pack did not create a tarball');

  const consumerRoot = resolve(temporaryRoot, 'consumer');
  await mkdir(consumerRoot);
  const installCommand = buildNpmCommand(
    ['install', '--prefix', consumerRoot, '--ignore-scripts', resolve(temporaryRoot, tarball)],
    npmRuntime,
  );
  execFileSync(installCommand.executable, [...installCommand.arguments], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  const cliCommand = buildInstalledCliCommand(consumerRoot, process.platform, process.execPath);
  cliChild = spawn(cliCommand.executable, [...cliCommand.arguments], {
    cwd: consumerRoot,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  readinessUrl = await waitForReadiness(cliChildWithStdout(cliChild));
  await waitUntilReachable(readinessUrl);
  console.log(`Installed CLI URL: ${readinessUrl}`);

  const playwright = spawn(process.execPath, [
    playwrightPath,
    'test',
    '--config',
    'apps/cli/playwright.config.ts',
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PDF_SCRUBBER_CLI_URL: readinessUrl,
      PDF_SCRUBBER_FIXTURE_ROOT: resolve(projectRoot, 'fixtures/generated'),
      PDF_SCRUBBER_PLAYWRIGHT_OUTPUT: resolve(temporaryRoot, 'playwright-output'),
    },
    shell: false,
    stdio: 'inherit',
  });
  const status = await waitForExit(playwright, 'Playwright');
  if (status !== 0) throw new Error(`Packaged CLI smoke exited with status ${status}`);
} finally {
  await cleanupCliSmoke({
    child: cliChild === undefined ? undefined : cliChildWithStdout(cliChild),
    readinessUrl,
    temporaryRoot,
  });
  console.log('Installed CLI cleanup: ok');
}

function waitForExit(child: ChildProcess, name: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== null) resolvePromise(code);
      else reject(new Error(`${name} terminated by ${signal}`));
    });
  });
}

async function waitUntilReachable(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return;
    } catch {
      // The child can print before the socket accepts the runner's request.
    } finally {
      clearTimeout(timer);
    }
    await delay(50);
  }
  throw new Error(`CLI URL did not become reachable: ${url}`);
}

function cliChildWithStdout(child: ChildProcess) {
  if (child.stdout === null) throw new Error('Owned CLI child stdout is unavailable');
  return Object.assign(child, { stdout: child.stdout });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

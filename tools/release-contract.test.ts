import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');
const STABLE_RELEASE_CLAIM = /(?:\bstable\s+(?:v?\d+\.\d+\.\d+|release|version)|\bv?1\.0\.0\s+(?:is\s+)?(?:available|published|released)|\b(?:available|published|released)\s+as\s+\bv?1\.0\.0|\b(?:current\s+)?version\s+(?:is\s+)?v?1\.0\.0|\[!\[(?:npm\s+)?version\])/i;

test('root and CLI licence files are identical MIT licences', async () => {
  const [rootLicense, cliLicense] = await Promise.all([
    readFile(resolve(projectRoot, 'LICENSE')),
    readFile(resolve(projectRoot, 'apps/cli/LICENSE')),
  ]);

  expect(rootLicense.equals(cliLicense)).toBe(true);
  expect(rootLicense.toString('utf8')).toContain('MIT License');
});

test('root README exposes release-safe badges and npm usage guidance', async () => {
  const readme = await readFile(resolve(projectRoot, 'README.md'), 'utf8');

  expect(readme).toMatch(/^\[!\[CI\]\(.*actions\/workflows\/.*\/badge\.svg.*\)$/m);
  expect(readme).toMatch(/^\[!\[License: MIT\]\(.*\)$/m);
  expect(readme).toMatch(/^\[!\[Node\.js\]\(.*\)$/m);
  expect(readme).not.toMatch(STABLE_RELEASE_CLAIM);
  expect(readme).toContain('npx pdf-scrubber@latest');
  expect(readme).toMatch(/^## Source development \(authorised contributors\)$/m);
  expect(readme).toMatch(/## Source development \(authorised contributors\)[\s\S]*npm ci[\s\S]*npm start/);
  expect(readme).toMatch(/loopback-only serving/i);
  expect(readme).toMatch(/port 5173.*fallback/i);
});

test('stable release guard rejects deferred v1.0.0 claims while allowing generic npm guidance', () => {
  const allowedPreReleaseReadme = 'Install with `npx pdf-scrubber@latest`; the version badge is deferred.';

  expect(allowedPreReleaseReadme).not.toMatch(STABLE_RELEASE_CLAIM);
  for (const allowedText of [
    'Requires Node.js 24.18.0.',
    '{"name":"pdf-scrubber","version":"0.0.1"}',
    'Version-specific release metadata is intentionally deferred.',
  ]) {
    expect(allowedText).not.toMatch(STABLE_RELEASE_CLAIM);
  }
  for (const claim of [
    'Stable v1.0.0.',
    'Stable version 1.0.0 is next.',
    'Stable v1.0.0 is available.',
    'v1.0.0 is available on npm.',
    'Version 1.0.0 has been released.',
    'Available as v1.0.0.',
    '[![Version](https://img.shields.io/npm/v/pdf-scrubber.svg)](https://www.npmjs.com/package/pdf-scrubber)',
    '[![npm version](https://img.shields.io/npm/v/pdf-scrubber.svg)](https://www.npmjs.com/package/pdf-scrubber)',
    'Current version is 1.0.0.',
  ]) {
    expect(claim).toMatch(STABLE_RELEASE_CLAIM);
  }
});

test('CLI README preserves runnable usage and avoids stale assembly wording', async () => {
  const packageReadme = await readFile(resolve(projectRoot, 'apps/cli/README.md'), 'utf8');

  expect(packageReadme).toContain('npx pdf-scrubber@latest');
  expect(packageReadme).toMatch(/loopback[\s\S]*port 5173[\s\S]*fallback[\s\S]*Ctrl-C/);
  expect(packageReadme).toMatch(/PDF and font processing remains local to the browser/);
  expect(packageReadme).not.toMatch(/being assembled incrementally|only package boundary and metadata/i);
  expect(packageReadme).not.toMatch(STABLE_RELEASE_CLAIM);
});

test('release boundaries do not add a changelog or provenance claim', async () => {
  const [{ stdout: trackedFiles }, packageReadme] = await Promise.all([
    execFileAsync('git', ['ls-files'], { cwd: projectRoot }),
    readFile(resolve(projectRoot, 'apps/cli/README.md'), 'utf8'),
  ]);

  expect(trackedFiles.split('\n').filter((file) => /(?:^|\/)CHANGELOG\.md$/i.test(file))).toEqual([]);
  expect(packageReadme).not.toMatch(/provenance/i);
});

test('root and internal workspace packages remain private', async () => {
  const packagePaths = ['package.json'];
  for (const workspace of ['apps', 'packages']) {
    const entries = await readdir(resolve(projectRoot, workspace), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'cli') {
        packagePaths.push(`${workspace}/${entry.name}/package.json`);
      }
    }
  }

  for (const packagePath of packagePaths) {
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, packagePath), 'utf8')) as {
      private?: boolean;
    };
    expect(packageJson.private, packagePath).toBe(true);
  }
});

test('release verification and publication workflows are pinned and release-only', async () => {
  const [verifyWorkflow, publishWorkflow, verifier, packageJsonText] = await Promise.all([
    readFile(resolve(projectRoot, '.github/workflows/verify.yml'), 'utf8'),
    readFile(resolve(projectRoot, '.github/workflows/publish.yml'), 'utf8'),
    readFile(resolve(projectRoot, 'scripts/verify.sh'), 'utf8'),
    readFile(resolve(projectRoot, 'package.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonText) as {
    scripts?: Record<string, string>;
  };

  expect(packageJson.scripts?.['verify:release']).toBe('sh scripts/verify.sh');
  expect(verifier).toContain('set -eu');
  for (const command of [
    'npm run build:fixtures',
    'npm run typecheck',
    'npm run test:unit',
    'npm run test:web:unit',
    'npm run verify:package',
    'npm run test:cli:smoke',
    'npm run test:web -- --full',
    'npm run test:m0',
  ]) {
    expect(verifier).toContain(command);
  }
  expect(verifier).toContain("ss -ltn '( sport = :5173 )'");
  expect(verifier).toContain('## Decision: GO');

  expect(publishWorkflow).toContain('release:');
  expect(publishWorkflow).toContain('types: [published]');
  expect(publishWorkflow).toContain('id-token: write');
  expect(publishWorkflow).toContain('contents: read');
  expect(publishWorkflow).toContain('!github.event.release.prerelease');
  expect(publishWorkflow).toContain('npm publish --workspace pdf-scrubber');
  expect(publishWorkflow).toContain('registry-url: https://registry.npmjs.org');
  for (const forbidden of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'pull_request_target']) {
    expect(publishWorkflow).not.toContain(forbidden);
  }
  expect(publishWorkflow).not.toMatch(/^\s*push:/m);
  expect(publishWorkflow).not.toMatch(/runs-on:\s*self-hosted/);

  const actionReferences = [...`${verifyWorkflow}\n${publishWorkflow}`.matchAll(
    /^\s*uses:\s*[^\s#]+@([^\s#]+)(?:\s+#\s*(v\S+))?\s*$/gm,
  )];
  expect(actionReferences.length).toBeGreaterThan(0);
  for (const reference of actionReferences) {
    expect(reference[1]).toMatch(/^[0-9a-f]{40}$/);
    expect(reference[2]).toMatch(/^v\S+$/);
  }
});

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');

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
  expect(readme).not.toMatch(/stable release|stable version/i);
  expect(readme).toContain('npx pdf-scrubber@latest');
  expect(readme).toMatch(/^## Source development \(authorised contributors\)$/m);
  expect(readme).toMatch(/## Source development \(authorised contributors\)[\s\S]*npm ci[\s\S]*npm start/);
  expect(readme).toMatch(/loopback-only serving/i);
  expect(readme).toMatch(/port 5173.*fallback/i);
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

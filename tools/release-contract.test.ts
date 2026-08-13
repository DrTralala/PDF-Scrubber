import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');
const STABLE_RELEASE_CLAIM = /(?:\bstable\s+(?:v?\d+\.\d+\.\d+|release|version)|\bv?1\.0\.0\s+(?:is\s+)?(?:available|published|released)|\b(?:available|published|released)\s+as\s+\bv?1\.0\.0|\b(?:current\s+)?version\s+(?:is\s+)?v?1\.0\.0|\[!\[(?:npm\s+)?version\])/i;

function expectInOrder(content: string, fragments: readonly string[]): void {
  let offset = 0;
  for (const fragment of fragments) {
    const index = content.indexOf(fragment, offset);
    expect(index, `Expected ${JSON.stringify(fragment)} after offset ${offset}`).toBeGreaterThanOrEqual(0);
    offset = index + fragment.length;
  }
}

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
  expectInOrder(verifier, [
    'npm run build:fixtures',
    'npm run typecheck',
    'npm run test:unit',
    'npm run test:web:unit',
    'npm run verify:package',
    'npm run test:cli:smoke',
    'npm run test:web -- --full',
    'npm run test:m0',
  ]);
  const verifierLines = verifier
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const command of ['npm run test:web -- --full', 'npm run test:m0']) {
    const gateIndex = verifierLines.indexOf(command);
    expect(gateIndex, `${command} must have a preceding port check`).toBeGreaterThan(0);
    expect(verifierLines[gateIndex - 1]).toBe('assert_port_5173_free');
    expect(verifierLines[gateIndex + 1]).toBe('assert_port_5173_free');
  }
  expect(verifierLines.filter((line) => line === 'assert_port_5173_free')).toHaveLength(4);
  expect(verifier).toContain("ss -ltn '( sport = :5173 )'");
  expect(verifier).toContain('## Decision: GO');

  for (const workflow of [verifyWorkflow, publishWorkflow]) {
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain("node-version: '24.18.0'");
    expect(workflow).toContain('cache: npm');
    expect(workflow).toContain('npm ci');
    expect(workflow).toContain('npx playwright install --with-deps chromium');
    expect(workflow).toContain('sudo apt-get install --no-install-recommends -y poppler-utils');
    expect(workflow).toContain('npm run verify:release');
  }

  expect(publishWorkflow).toContain('release:');
  expect(publishWorkflow).toContain('types: [published]');
  expect(publishWorkflow).toContain('id-token: write');
  expect(publishWorkflow).toContain('contents: read');
  expect(publishWorkflow).toContain('!github.event.release.prerelease');
  expect(publishWorkflow).toContain('npm publish --workspace pdf-scrubber');
  expect(publishWorkflow).toContain('registry-url: https://registry.npmjs.org');
  expect(publishWorkflow).toContain('group: publish-${{ github.event.release.tag_name }}');
  expect(publishWorkflow).toContain('cancel-in-progress: false');
  expect(publishWorkflow).toContain('ref: ${{ github.event.release.tag_name }}');
  expectInOrder(publishWorkflow, [
    'package_name=$(node -p "require(\'./apps/cli/package.json\').name")',
    'package_version=$(node -p "require(\'./apps/cli/package.json\').version")',
    'test "$RELEASE_TAG" = "v$package_version"',
    'npm ci',
    'npm run verify:release',
    'npm publish --workspace pdf-scrubber',
  ]);
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

test('only approved project-local OpenCode release automation is trackable', async () => {
  const approvedPaths = [
    '.opencode/commands/release.md',
    '.opencode/skills/pdf-scrubber-release/SKILL.md',
    '.opencode/skills/pdf-scrubber-run-validate/SKILL.md',
    '.opencode/skills/pdf-scrubber-run-validate/references/automated-checks.md',
    '.opencode/skills/pdf-scrubber-run-validate/scripts/reject-validation.js',
  ];
  const localOnlyPaths = [
    '.opencode/package.json',
    '.opencode/package-lock.json',
    '.opencode/bun.lock',
    '.opencode/node_modules/example.js',
    '.opencode/plugins/project-validation-policy.ts',
    'opencode.json',
    'docs/example.md',
  ];

  for (const path of approvedPaths) {
    await expect(execFileAsync('git', ['check-ignore', '--quiet', '--no-index', path], {
      cwd: projectRoot,
    }), path).rejects.toMatchObject({ code: 1 });
  }
  for (const path of localOnlyPaths) {
    await expect(execFileAsync('git', ['check-ignore', '--quiet', '--no-index', path], {
      cwd: projectRoot,
    }), path).resolves.toBeDefined();
  }
});

test('release command delegates one explicit semver argument to the release skill', async () => {
  const command = await readFile(resolve(projectRoot, '.opencode/commands/release.md'), 'utf8');

  expect(command).toMatch(/^---\ndescription: .+\nagent: build\n---\n/);
  expect(command).toContain('$ARGUMENTS');
  expect(command).toMatch(/exactly one positional argument/i);
  expect(command).toMatch(/semantic version|semver/i);
  expect(command).toMatch(/before (?:running any command|any edit)/i);
  expect(command).toMatch(/invoke (?:the )?`?pdf-scrubber-release`?/i);
  expect(command).toMatch(/pass `?\$ARGUMENTS`? verbatim/i);
});

test('release skill enforces preparation, publication, and post-release contracts', async () => {
  const skill = await readFile(resolve(
    projectRoot,
    '.opencode/skills/pdf-scrubber-release/SKILL.md',
  ), 'utf8');

  expect(skill).toMatch(/^---\nname: pdf-scrubber-release\ndescription: Use when .+\n---\n/);
  expect(skill).toMatch(/clean, synchronised[\s\S]*`main`/i);
  expect(skill).toMatch(/tag[\s\S]*npm[\s\S]*(?:absent|does not exist)/i);
  expect(skill).toContain('apps/cli/package.json');
  expect(skill).toMatch(/package-lock\.json/);
  expect(skill).toMatch(/README[\s\S]*(?:badge|pinned)/i);
  expect(skill).toContain('npm run verify:release');
  expect(skill).toMatch(/SHA[\s\S]*tree[\s\S]*(?:stable|unchanged)/i);
  expect(skill).toMatch(/exact-SHA `Verify`/);
  expect(skill).toMatch(/complete release notes/i);
  expect(skill).toMatch(/preview[\s\S]*explicit confirmation/i);
  expect(skill).toContain(
    'gh release create v<version> --target <sha> --title v<version> --notes-file <temporary-file>',
  );
  expect(skill).toMatch(/remove[\s\S]*temporary notes file/i);
  expect(skill).toMatch(/release-triggered[\s\S]*exact (?:release )?(?:target )?SHA/i);
  expect(skill).toMatch(/npm view[\s\S]*clean installed-package smoke/i);
  expect(skill).toMatch(/0\.0\.1[\s\S]*one-time release plan/i);

  for (const forbidden of [
    /force push/i,
    /history rewrite/i,
    /ordinary local `npm publish`/i,
    /NPM_TOKEN/,
    /NODE_AUTH_TOKEN/,
    /version reuse/i,
  ]) {
    expect(skill).toMatch(forbidden);
  }
});

test('tracked project policy test has no clean-checkout dependency on ignored runtime files', async () => {
  const policyTest = await readFile(resolve(projectRoot, 'tools/project-validation-policy.test.ts'), 'utf8');

  expect(policyTest).not.toContain("../.opencode/plugins/project-validation-policy");
  expect(policyTest).not.toMatch(/readFile\([^)]*opencode\.json/s);
  expect(policyTest).toMatch(
    /import \{\s*PROJECT_VALIDATION_BASH_ENTRIES,\s*applyProjectValidationBashPolicy,?\s*\} from '\.\/project-validation-policy';/,
  );
});

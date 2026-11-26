import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';

import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');
const STABLE_RELEASE_CLAIM = /(?:\bstable\s+(?:v?\d+\.\d+\.\d+|release|version)|\bv?1\.1\.0\s+(?:is\s+)?(?:available|published|released)|\b(?:available|published|released)\s+as\s+\bv?1\.1\.0|\b(?:current\s+)?version\s+(?:is\s+)?v?1\.1\.0|\[!\[(?:npm\s+)?version\])/i;
const STABLE_PACKAGE_PUBLICATION_CLAIM = /(?:\b(?:pdf-scrubber@)?v?1\.1\.0\s+(?:is\s+)?(?:available|published|released)\b|\b(?:available|published|released)\s+as\s+[`'\"]?(?:pdf-scrubber@)?v?1\.1\.0\b)/i;

function expectInOrder(content: string, fragments: readonly string[]): void {
  let offset = 0;
  for (const fragment of fragments) {
    const index = content.indexOf(fragment, offset);
    expect(index, `Expected ${JSON.stringify(fragment)} after offset ${offset}`).toBeGreaterThanOrEqual(0);
    offset = index + fragment.length;
  }
}

async function expectIgnored(path: string, ignored: boolean): Promise<void> {
  try {
    await execFileAsync('git', ['check-ignore', '--quiet', '--no-index', path], {
      cwd: projectRoot,
    });
    expect(ignored, `${path} is ignored`).toBe(true);
  } catch (error) {
    expect(error, `${path} must produce the expected check-ignore status`).toMatchObject({ code: 1 });
    expect(ignored, `${path} is not ignored`).toBe(false);
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

test('root README exposes stable release badges and npm usage guidance', async () => {
  const [readme, workflowFiles] = await Promise.all([
    readFile(resolve(projectRoot, 'README.md'), 'utf8'),
    readdir(resolve(projectRoot, '.github/workflows')),
  ]);
  const workflowBadge = readme.match(
    /^\[!\[Verify\]\(https:\/\/github\.com\/DrTralala\/PDF-Scrubber\/actions\/workflows\/([^/)]+)\/badge\.svg\)\]\(https:\/\/github\.com\/DrTralala\/PDF-Scrubber\/actions\/workflows\/([^/)]+)\)$/m,
  );

  expect(workflowBadge).not.toBeNull();
  expect(workflowBadge?.[1]).toBe('verify.yml');
  expect(workflowBadge?.[2]).toBe(workflowBadge?.[1]);
  expect(workflowFiles).toContain(workflowBadge?.[1]);
  expect(readme).toMatch(/^\[!\[Licence: MIT\]\(.*\)$/m);
  expect(readme).toMatch(/^\[!\[Node\.js 24\.22\.1\]\(.*\)$/m);
  expectInOrder(readme, ['npx pdf-scrubber@latest', 'npx pdf-scrubber@1.3.0']);
  expect(readme).toMatch(/^\[!\[Version\]\(https:\/\/img\.shields\.io\/github\/v\/release\/DrTralala\/PDF-Scrubber\?label=version&color=blue&sort=date&style=flat-square\)\]\(https:\/\/github\.com\/DrTralala\/PDF-Scrubber\/releases\/latest\)$/m);
  expect(readme).toMatch(/^## Source development$/m);
  expect(readme).toMatch(/## Source development[\s\S]*From the repository root:[\s\S]*npm ci[\s\S]*npm start/);
  expect(readme).not.toMatch(/^## Supported editing$/m);
  expect(readme).not.toMatch(/GitHub source is private|authorised contributors/i);
  expect(readme).toMatch(/serves the editor on loopback only/i);
  expect(readme).toMatch(/port `5173`.*fallback/i);
});

test('stable release guard rejects malformed v1.1.0 claims while allowing generic npm guidance', () => {
  const allowedPreReleaseReadme = 'Install with `npx pdf-scrubber@latest`; the version badge is deferred.';

  expect(allowedPreReleaseReadme).not.toMatch(STABLE_RELEASE_CLAIM);
  for (const allowedText of [
    'Requires Node.js 24.22.1.',
    '{"name":"pdf-scrubber","version":"0.0.1"}',
    'Version-specific release metadata is intentionally deferred.',
  ]) {
    expect(allowedText).not.toMatch(STABLE_RELEASE_CLAIM);
  }
  for (const claim of [
    'Stable v1.1.0.',
    'Stable version 1.1.0 is next.',
    'Stable v1.1.0 is available.',
    'v1.1.0 is available on npm.',
    'Version 1.1.0 has been released.',
    'Available as v1.1.0.',
    '[![Version](https://img.shields.io/npm/v/pdf-scrubber.svg)](https://www.npmjs.com/package/pdf-scrubber)',
    '[![npm version](https://img.shields.io/npm/v/pdf-scrubber.svg)](https://www.npmjs.com/package/pdf-scrubber)',
    'Current version is 1.1.0.',
  ]) {
    expect(claim).toMatch(STABLE_RELEASE_CLAIM);
  }
});

test('CLI README preserves runnable usage and avoids stale assembly wording', async () => {
  const packageReadme = await readFile(resolve(projectRoot, 'apps/cli/README.md'), 'utf8');

  expectInOrder(packageReadme, ['npx pdf-scrubber@latest', 'npx pdf-scrubber@1.3.0']);
  expect(packageReadme).toMatch(/loopback[\s\S]*port 5173[\s\S]*fallback[\s\S]*Ctrl-C/);
  expect(packageReadme).toMatch(/PDF and font processing remains local to the browser/);
  expect(packageReadme).toMatch(/GitHub source is public/);
  expect(packageReadme).not.toMatch(/GitHub source is private/);
  expect(packageReadme).not.toMatch(/being assembled incrementally|only package boundary and metadata/i);
  expect(packageReadme).not.toMatch(/version-specific release metadata is intentionally deferred/i);
  expect(packageReadme).not.toMatch(STABLE_PACKAGE_PUBLICATION_CLAIM);
});

test('root README documents the portable .7z layout, settings and safe updates', async () => {
  const readme = await readFile(resolve(projectRoot, 'README.md'), 'utf8');
  const portableSection = readme.slice(readme.indexOf('## Windows portable app'));

  expect(portableSection).toContain('PDF-Scrubber-<version>-win-x64-portable.7z');
  expect(portableSection).toMatch(/extract the complete `PDF-Scrubber\/` folder/i);
  expect(portableSection).toContain('PDF-Scrubber/\n  PDF-Scrubber.exe\n  settings.json\n  config/');
  const settingsExample = portableSection.match(/```json\s+([\s\S]*?)```/);
  expect(JSON.parse(settingsExample?.[1] ?? 'null')).toEqual({schemaVersion: 1, window: {width: 1280, height: 860}});
  expect(portableSection).toMatch(/schema is strict.*`schemaVersion` must be `1`/i);
  expect(portableSection).toMatch(/width.*integer.*760.*16384/i);
  expect(portableSection).toMatch(/height.*integer.*560.*16384/i);
  expect(portableSection).toMatch(/unknown keys.*visible error/i);
  expect(portableSection).toMatch(/malformed.*invalid settings are not silently overwritten/i);
  expect(portableSection).toMatch(/move the entire folder only when the app is closed/i);
  expect(portableSection).toMatch(/extract the new release to a separate folder/i);
  expect(portableSection).toMatch(/with both copies closed/i);
  expect(portableSection).toMatch(/copy the validated.*settings\.json.*config\/profile/i);
  expect(portableSection).toMatch(/do not copy.*config\/runtime/i);
  expect(portableSection).toMatch(/do not copy.*or blindly replace your settings/i);
  expect(portableSection).toMatch(/AppData.*not migrated or removed automatically/i);
  expect(portableSection).toMatch(/No separate Node\.js installation or installer is needed/i);
  expect(portableSection).toMatch(/unsigned.*Windows may show a security warning/i);
  expect(portableSection).toMatch(/may write data outside the application folder/i);
  expect(portableSection).not.toContain('PDF-Scrubber-<version>-win-x64-portable.exe');
  expect(portableSection).not.toMatch(/download[^\n]*self-extracting/i);
});

test('future release instructions require tested portable archives without changing the npm boundary', async () => {
  const instructions = await readFile(resolve(projectRoot, 'AGENTS.md'), 'utf8');

  expect(instructions).toMatch(/both the npm package and the tested Windows x64 portable `\.7z` archive/i);
  expect(instructions).toMatch(/keep the root README.*latest-release badge dynamic/i);
  expect(instructions).toMatch(/smoke-test the actual root launcher from the final `\.7z` after extraction/i);
  expectInOrder(instructions, [
    'smoke-test the actual root launcher from the final `.7z` after extraction',
    'before attaching assets',
  ]);
  expect(instructions).toMatch(/the `\.7z` archive and matching SHA-256 file/i);
  expect(instructions).toMatch(/Attach assets to the existing release only.*Windows archive smoke/i);
  expect(instructions).toMatch(/app-managed state.*under `config\/`/i);
  expect(instructions).toMatch(/not a zero-OS-traces guarantee/i);
  expect(instructions).toContain('never handle npm publish tokens or run ordinary local `npm publish`');
});

test('release boundaries do not add a changelog', async () => {
  const { stdout: trackedFiles } = await execFileAsync('git', ['ls-files'], { cwd: projectRoot });

  expect(trackedFiles.split('\n').filter((file) => /(?:^|\/)CHANGELOG\.md$/i.test(file))).toEqual([]);
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
    expect(workflow).toContain("node-version: '24.22.1'");
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

test('Verify uses the npm cache while Publish disables package-manager caching', async () => {
  const [verifyWorkflow, publishWorkflow] = await Promise.all([
    readFile(resolve(projectRoot, '.github/workflows/verify.yml'), 'utf8'),
    readFile(resolve(projectRoot, '.github/workflows/publish.yml'), 'utf8'),
  ]);

  expect(verifyWorkflow).toContain('cache: npm');
  expect(publishWorkflow).not.toMatch(/^\s*cache:/m);
  expect(publishWorkflow).not.toMatch(/^\s*uses:\s*actions\/cache@/m);
});

test('Publish proves the checked-out release tag commit before version checks', async () => {
  const publishWorkflow = await readFile(
    resolve(projectRoot, '.github/workflows/publish.yml'),
    'utf8',
  );

  expect(publishWorkflow).toMatch(
    /ref: \$\{\{ github\.event\.release\.tag_name \}\}\n\s+- name: Verify release target SHA\n\s+run: \|\n\s+checked_out_sha=\$\(git rev-parse HEAD\)\n\s+release_tag_sha=\$\(git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"\)\n\s+test "\$checked_out_sha" = "\$release_tag_sha"/,
  );
  expectInOrder(publishWorkflow, [
    'checked_out_sha=$(git rev-parse HEAD)',
    'release_tag_sha=$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")',
    'test "$checked_out_sha" = "$release_tag_sha"',
    'package_name=$(node -p "require(\'./apps/cli/package.json\').name")',
    'test "$RELEASE_TAG" = "v$package_version"',
    'npm publish --workspace pdf-scrubber',
  ]);
});

test('Windows portable workflow smoke-tests the final archive before checksumming or uploading', async () => {
  const [workflow, publishWorkflow, portableBuild, runtimeMain] = await Promise.all([
    readFile(resolve(projectRoot, '.github/workflows/desktop.yml'), 'utf8'),
    readFile(resolve(projectRoot, '.github/workflows/publish.yml'), 'utf8'),
    readFile(resolve(projectRoot, 'apps/desktop/build-portable.ps1'), 'utf8'),
    readFile(resolve(projectRoot, 'apps/desktop/runtime/main.cjs'), 'utf8'),
  ]);

  expectInOrder(workflow, [
    'Build unsigned Windows x64 portable executable',
    'Prepare Microsoft Sysinternals Handle for optional relocation diagnostics',
    'Smoke-test the final portable .7z archive with Handle diagnostics',
    'npm run desktop:smoke -- --archive "$($archive.FullName)" --fixture "$fixture"',
    "if ($LASTEXITCODE -ne 0) { throw 'Portable archive smoke failed.' }",
    'Smoke-test the final portable .7z archive without Handle diagnostics',
    'npm run desktop:smoke -- --archive "$($archive.FullName)" --fixture "$fixture"',
    'Finalise tested portable archive assets',
    '$hash = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant()',
    'Upload tested portable build artifact',
  ]);
  expect(workflow).toContain("$archives = @(Get-ChildItem -LiteralPath 'artifacts/desktop/output' -Filter '*.7z' -File)");
  expect(workflow).toContain('artifacts/desktop/output/*.7z');
  expect(workflow).toContain('artifacts/desktop/output/*.7z.sha256');
  expect(workflow).not.toContain('artifacts/desktop/output/*.exe');
  expect(workflow).toContain('[[ ${#archives[@]} -eq 1 && -f "${archives[0]}" ]]');
  expect(workflow).toContain('checksum="${archive}.sha256"');
  expect(workflow).toContain('[[ "$EDITOR_SHA" == "$RELEASE_SHA" ]]');
  expect(workflow).toContain('[[ "$PACKAGING_SHA" == "$RELEASE_SHA" ]]');
  expect(workflow).toContain('editor_sha: ${{ steps.identities.outputs.editor_sha }}');
  expect(workflow).toContain('packaging_sha: ${{ steps.identities.outputs.packaging_sha }}');
  expect(workflow).toContain('$editorHead -ne $editorSha');
  expect(workflow).toContain('"v$editorVersion" -ne $env:EDITOR_TAG');
  expect(workflow).toContain('$editorSha -ne $env:EXPECTED_RELEASE_SHA -or $packagingSha -ne $env:EXPECTED_RELEASE_SHA');
  expect(workflow).toContain('Prepare desktop package');
  expect(workflow).toContain('--editor-version $env:EDITOR_VERSION --output artifacts/desktop/package-input');
  expectInOrder(workflow, [
    'existing_assets=$(gh release view',
    'Refusing to overwrite existing release asset:',
    'gh release upload',
  ]);
  expect(workflow).toContain("if: ${{ github.event_name == 'release' && !github.event.release.prerelease }}");
  expect(workflow).toContain("types: [published]");
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).toMatch(/lock_diagnostics:[\s\S]*?default: false[\s\S]*?type: boolean/);
  expect(workflow).toContain('if: ${{ github.event_name == \'workflow_dispatch\' && inputs.lock_diagnostics }}');
  expect(workflow).toContain('if: ${{ always() && github.event_name == \'workflow_dispatch\' && inputs.lock_diagnostics }}');
  expect(workflow.match(/PDF_SCRUBBER_HANDLE_EXE:/g)).toHaveLength(1);
  expect(portableBuild).toContain("'MSVC dumpbin.exe is required to inspect the compiled launcher imports; no tool was installed.'");
  expect(portableBuild).toContain('/dependents $launcherExecutable');
  expect(portableBuild).toContain('/dependents $packagedLauncher');
  expect(portableBuild).toContain("The final staged portable launcher imports a separately installed Visual C++ redistributable DLL.");
  expect(portableBuild).toContain('Assert-PackagedRuntime $unpackedApplication');
  expect(portableBuild).toContain('Assert-PackagedRuntime $runtimeDirectory');
  expect(portableBuild).toMatch(/VCRUNTIME\|MSVCP\|CONCRT\|MFC/);
  expect(runtimeMain).toContain("event: 'portable-managed-paths'");
  expect(runtimeMain).toContain('tempEnvironment:');
  expect(runtimeMain).toContain("event: 'portable-window-ready'");
  expect(runtimeMain).toContain('requestedWidth: settings.window.width');
  expect(runtimeMain).toContain('requestedHeight: settings.window.height');
  expect(publishWorkflow).toContain('npm publish --workspace pdf-scrubber');
});

test.skipIf(process.platform !== 'linux')(
  'release attachment accepts only an exact LF or CRLF checksum sidecar',
  async () => {
    const workflow = await readFile(resolve(projectRoot, '.github/workflows/desktop.yml'), 'utf8');
    const comparisonStart = workflow.indexOf('          checksum="${archive}.sha256"\n');
    const comparisonEnd = workflow.indexOf('\n\n          existing_assets=', comparisonStart);

    expect(comparisonStart).toBeGreaterThanOrEqual(0);
    expect(comparisonEnd).toBeGreaterThan(comparisonStart);
    const comparison = workflow
      .slice(comparisonStart, comparisonEnd)
      .split('\n')
      .map((line) => line.replace(/^          /, ''))
      .join('\n');
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-release-checksum-'));

    try {
      const archive = join(temporaryRoot, 'PDF-Scrubber-1.0.0-win-x64-portable.7z');
      const archiveBytes = Buffer.from('release checksum fixture');
      const digest = createHash('sha256').update(archiveBytes).digest('hex');
      const checksumLine = `${digest}  ${basename(archive)}`;
      await writeFile(archive, archiveBytes);

      const expectSidecar = async (contents: string, accepted: boolean): Promise<void> => {
        await writeFile(`${archive}.sha256`, contents, 'ascii');
        const script = [
          'set -euo pipefail',
          'archive="$ARCHIVE"',
          'checksums=("$ARCHIVE.sha256")',
          comparison,
        ].join('\n');
        let exitCode = 0;
        try {
          await execFileAsync('bash', ['-c', script], {
            cwd: projectRoot,
            env: { ...process.env, ARCHIVE: archive },
          });
        } catch (error) {
          exitCode = (error as { code?: number }).code ?? -1;
        }
        expect(exitCode === 0, JSON.stringify(contents)).toBe(accepted);
      };

      await expectSidecar(`${checksumLine}\n`, true);
      await expectSidecar(`${checksumLine}\r\n`, true);
      await expectSidecar(`${digest}  another-archive.7z\n`, false);
      await expectSidecar(`${digest} ${basename(archive)}\n`, false);
      const wrongDigest = `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`;
      await expectSidecar(`${wrongDigest}  ${basename(archive)}\n`, false);
      await expectSidecar(`${checksumLine}\nextra record\n`, false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test('maps runner identity explicitly and accepts only a canonical Handle preflight no-match', async () => {
  const workflow = await readFile(resolve(projectRoot, '.github/workflows/desktop.yml'), 'utf8');

  expect(workflow).toContain('PDF_SCRUBBER_RUNNER_ENVIRONMENT: ${{ runner.environment }}');
  expect(workflow).toContain("$env:PDF_SCRUBBER_RUNNER_ENVIRONMENT -ne 'github-hosted'");
  expect(workflow).not.toContain('$env:RUNNER_ENVIRONMENT');
  expect(workflow).toContain("$canonicalNoMatch = 'No matching handles found.'");
  expect(workflow).toContain('$acceptedExitCodes = @(0, 1)');
  expect(workflow).toContain('$hasCanonicalNoMatch = $preflightLines -ccontains $canonicalNoMatch');
  expect(workflow).toContain('$hasPreflightError = @(');
  expect(workflow).toContain('(?i)(?:\\busage\\b|\\bunknown\\b|\\binvalid\\b|\\berror\\b|\\bfailed\\b|license agreement|end user license)');
  expect(workflow).toContain('$acceptedExitCode = $probeProcess.ExitCode -in $acceptedExitCodes');
  expect(workflow).toMatch(/if \(-not \$acceptedExitCode -or -not \$hasCanonicalNoMatch -or \$hasPreflightError\)/);
});

test('OpenCode project state is ignored and untracked', async () => {
  for (const path of [
    '.opencode/commands/release.md',
    '.opencode/skills/pdf-scrubber-release/SKILL.md',
    '.opencode/package.json',
    'opencode.json',
    'docs/example.md',
  ]) {
    await expectIgnored(path, true);
  }

  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--', '.opencode', 'opencode.json'],
    { cwd: projectRoot },
  );
  expect(stdout.trim()).toBe('');
});

test('tracked project policy test has no clean-checkout dependency on ignored runtime files', async () => {
  const policyTest = await readFile(resolve(projectRoot, 'tools/project-validation-policy.test.ts'), 'utf8');

  expect(policyTest).not.toContain("../.opencode/plugins/project-validation-policy");
  expect(policyTest).not.toMatch(/readFile\([^)]*opencode\.json/s);
  expect(policyTest).toMatch(
    /import \{\s*PROJECT_VALIDATION_BASH_ENTRIES,\s*applyProjectValidationBashPolicy,?\s*\} from '\.\/project-validation-policy';/,
  );
});

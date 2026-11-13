import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

test('builds an unpacked Windows app before staging an ordinary .7z archive', async () => {
  const [desktopPackageText, builderConfig, buildScript] = await Promise.all([
    readFile(resolve(projectRoot, 'apps/desktop/package.json'), 'utf8'),
    readFile(resolve(projectRoot, 'apps/desktop/electron-builder.config.cjs'), 'utf8'),
    readFile(resolve(projectRoot, 'apps/desktop/build-portable.ps1'), 'utf8'),
  ]);
  const desktopPackage = JSON.parse(desktopPackageText) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const electronBuilderConfig = require('../apps/desktop/electron-builder.config.cjs') as {
    directories?: Readonly<{ app?: string }>;
  };

  expect(desktopPackage.devDependencies).toMatchObject({
    electron: '45.1.0',
    'electron-builder': '26.18.0',
  });
  expect(desktopPackage.scripts?.['build:portable']).toMatch(/build-portable\.ps1/);
  expect(electronBuilderConfig.directories?.app)
    .toBe(resolve(projectRoot, 'artifacts/desktop/package-input'));
  expect(builderConfig).toContain('electron-build');
  expect(builderConfig).not.toMatch(/target:\s*['"]portable['"]|nsis/i);
  expect(buildScript).toContain('PDF-Scrubber-${version}-win-x64-portable.7z');
  expect(buildScript).toContain('PDF-Scrubber.exe');
  expect(buildScript).toContain('settings.json');
  expect(buildScript).toContain('$expectedRootEntries');
  expect(buildScript).toContain('$configEntries');
  expect(buildScript).toContain("'PDF-Scrubber'");
  expect(buildScript).not.toMatch(/-sfx|\.exe\.7z/i);
  expect(buildScript).toContain('PDF-Scrubber');
  expect(buildScript).toMatch(/7z(?:\.exe)?/i);
  expect(buildScript).toMatch(/Get-Command|vswhere|VsDevCmd/i);
});

test('compiles a static native GUI launcher without overriding the CRT entry point', async () => {
  const launcher = await readFile(resolve(projectRoot, 'apps/desktop/launcher/main.cpp'), 'utf8');
  const buildScript = await readFile(resolve(projectRoot, 'apps/desktop/build-portable.ps1'), 'utf8');

  for (const required of [
    'GetModuleFileNameW',
    'FILE_ATTRIBUTE_REPARSE_POINT',
    'CreateProcessW',
    'WaitForSingleObject',
    'GetExitCodeProcess',
    'CommandLineToArgvW',
    'MessageBoxW',
    'wWinMain',
    'PDF_SCRUBBER_PORTABLE_ROOT',
    'PDF-Scrubber.exe',
    '--user-data-dir=',
    'electron_run_as_node',
    'electron_log_file',
    'TMPDIR',
  ]) {
    expect(launcher).toContain(required);
  }
  expect(buildScript).toContain('/MT');
  expect(buildScript).toContain('/SUBSYSTEM:WINDOWS');
  expect(buildScript).not.toContain('/ENTRY:');
});

test('checks native write rights for the root and Electron storage before process creation', async () => {
  const launcher = await readFile(resolve(projectRoot, 'apps/desktop/launcher/main.cpp'), 'utf8');

  expect(launcher).toContain('FILE_ADD_FILE');
  expect(launcher).toContain('FILE_ADD_SUBDIRECTORY');
  expect(launcher).toContain('hasDirectoryWriteAccess(root');
  expect(launcher).toContain('hasDirectoryWriteAccess(profile');
  expect(launcher).toContain('hasDirectoryWriteAccess(temp');
});

test('requires the root launcher marker and configures storage before Electron ready', async () => {
  const main = await readFile(resolve(projectRoot, 'apps/desktop/runtime/main.cjs'), 'utf8');
  const preflightIndex = main.indexOf('preflightPortableStorage(');
  const lockIndex = main.indexOf('app.requestSingleInstanceLock()');
  const storageIndex = main.indexOf('preparePortableStorage(');
  const pathsIndex = main.indexOf('configurePortableApp(');
  const readyIndex = main.indexOf('app.whenReady()');

  expect(main).toContain('PDF_SCRUBBER_PORTABLE_ROOT');
  expect(main).toContain('user-data-dir');
  expect(main).toContain('launcher');
  expect(preflightIndex).toBeGreaterThanOrEqual(0);
  expect(preflightIndex).toBeLessThan(lockIndex);
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(storageIndex).toBeGreaterThan(lockIndex);
  expect(pathsIndex).toBeGreaterThan(storageIndex);
  expect(readyIndex).toBeGreaterThan(pathsIndex);
  expect(main).toContain('width: settings.window.width');
  expect(main).toContain('height: settings.window.height');
});

test('uses Electron native failure exits and closes the startup server first', async () => {
  const main = await readFile(resolve(projectRoot, 'apps/desktop/runtime/main.cjs'), 'utf8');
  const bootstrapCatchStart = main.indexOf('} catch (error) {');
  const bootstrapCatchEnd = main.indexOf('\n}\n\napp.on', bootstrapCatchStart);
  const readyHandlerStart = main.indexOf('app.whenReady().then(() => startDesktopEditor');
  const editorCatchStart = main.indexOf('.catch((error) => {', readyHandlerStart);
  const editorCatchEnd = main.indexOf('\n  });', editorCatchStart);
  const failureHandlerStart = main.indexOf('async function exitAfterEditorStartupFailure');
  const failureHandlerEnd = main.indexOf('\nasync function startDesktopEditor', failureHandlerStart);
  const secondInstanceStart = main.indexOf('if (!app.requestSingleInstanceLock())');
  const secondInstanceEnd = main.indexOf('} else {', secondInstanceStart);
  const bootstrapFailure = main.slice(bootstrapCatchStart, bootstrapCatchEnd);
  const editorFailure = main.slice(editorCatchStart, editorCatchEnd);
  const failureHandler = main.slice(failureHandlerStart, failureHandlerEnd);

  expect(bootstrapFailure).toContain('app.exit(1)');
  expect(editorFailure).toContain('exitAfterEditorStartupFailure(error)');
  expect(failureHandler).toContain('await serverToClose.close()');
  expect(failureHandler).toContain('finally {');
  expect(failureHandler.indexOf('app.exit(1)'))
    .toBeGreaterThan(failureHandler.lastIndexOf('finally {'));
  expect(failureHandler.indexOf('await serverToClose.close()'))
    .toBeLessThan(failureHandler.indexOf('app.exit(1)'));
  expect(main.slice(secondInstanceStart, secondInstanceEnd)).toContain('app.quit()');
  expect(main.slice(secondInstanceStart, secondInstanceEnd)).not.toContain('app.exit(1)');
});

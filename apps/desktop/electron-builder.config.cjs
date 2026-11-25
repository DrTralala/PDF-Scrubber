const { lstat, rm } = require('node:fs/promises');
const { resolve } = require('node:path');

async function removeCollectedNodeModules(context) {
  const appDirectory = resolve(context.appOutDir, 'resources', 'app');
  const appDetails = await lstat(appDirectory);
  if (!appDetails.isDirectory() || appDetails.isSymbolicLink()) {
    throw new Error(`Packaged Electron app is not a regular directory: ${appDirectory}`);
  }

  // The wrapper only uses Electron and Node built-ins. Remove dependencies that
  // electron-builder may automatically collect, then let the packaging script
  // and archive smoke independently verify the final runtime tree.
  const nodeModulesDirectory = resolve(appDirectory, 'node_modules');
  await rm(nodeModulesDirectory, { recursive: true, force: true });
  try {
    await lstat(nodeModulesDirectory);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Packaged Electron app still contains node_modules: ${nodeModulesDirectory}`);
}

module.exports = {
  appId: 'org.pdfscrubber.desktop',
  productName: 'PDF-Scrubber',
  directories: {
    app: resolve(__dirname, '../../artifacts/desktop/package-input'),
    output: process.env.PDF_SCRUBBER_ELECTRON_BUILD_OUTPUT
      || resolve(__dirname, '../../artifacts/desktop/electron-build'),
  },
  files: ['**/*', '!**/node_modules/**'],
  electronLanguages: ['en-US', 'en-GB'],
  // The loopback server validates opened regular files; keep its assets unpacked.
  asar: false,
  npmRebuild: false,
  afterPack: removeCollectedNodeModules,
};

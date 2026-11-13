const { resolve } = require('node:path');

module.exports = {
  appId: 'org.pdfscrubber.desktop',
  productName: 'PDF-Scrubber',
  directories: {
    app: resolve(__dirname, '../../artifacts/desktop/package-input'),
    output: process.env.PDF_SCRUBBER_ELECTRON_BUILD_OUTPUT
      || resolve(__dirname, '../../artifacts/desktop/electron-build'),
  },
  files: ['**/*'],
  // The loopback server validates opened regular files; keep its assets unpacked.
  asar: false,
  npmRebuild: false,
};

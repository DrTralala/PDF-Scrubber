module.exports = {
  appId: 'org.pdfscrubber.desktop',
  productName: 'PDF-Scrubber',
  directories: {
    app: '../../artifacts/desktop/package-input',
    output: '../../artifacts/desktop/output',
  },
  files: ['**/*'],
  // The loopback server validates opened regular files; keep its assets unpacked.
  asar: false,
  npmRebuild: false,
  win: {
    target: [{ target: 'portable', arch: ['x64'] }],
  },
  artifactName: 'PDF-Scrubber-${version}-win-${arch}-portable.${ext}',
};

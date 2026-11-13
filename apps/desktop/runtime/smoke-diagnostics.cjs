function createSmokeDiagnosticSink({
  diagnosticsPath,
  appendFile,
  createBoundedDiagnosticWriter,
}) {
  let fileWriteFailed = diagnosticsPath === undefined;
  const boundedWriter = createBoundedDiagnosticWriter((line) => {
    if (fileWriteFailed) return;
    try {
      appendFile(diagnosticsPath, line, { encoding: 'utf8' });
    } catch {
      fileWriteFailed = true;
    }
  }, { maxRecords: 64, maxBytes: 16_384 });

  return Object.freeze({
    write: boundedWriter,
    fileWriteFailed: () => fileWriteFailed,
  });
}

module.exports = { createSmokeDiagnosticSink };

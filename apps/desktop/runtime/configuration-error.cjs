const ERROR_TITLE = 'PDF-Scrubber — Configuration error';

class ConfigurationError extends Error {
  constructor(problem, { line, column, cause } = {}) {
    if (typeof problem !== 'string' || problem.trim().length === 0 || /[\r\n\u0000-\u001f\u007f]/.test(problem)) {
      throw new TypeError('Configuration problem must be non-empty single-line text');
    }
    if ((line === undefined) !== (column === undefined)
      || (line !== undefined && (!Number.isInteger(line) || line < 1
        || !Number.isInteger(column) || column < 1))) {
      throw new TypeError('Configuration error location must contain positive line and column values');
    }

    super(problem, cause === undefined ? undefined : { cause });
    this.name = 'ConfigurationError';
    this.problem = problem;
    if (line !== undefined) {
      this.line = line;
      this.column = column;
    }
  }
}

function formatConfigurationError(error) {
  if (!(error instanceof ConfigurationError)) {
    throw new TypeError('Expected a ConfigurationError');
  }

  const location = error.line === undefined
    ? ''
    : `Location: line ${error.line}, column ${error.column}\n`;
  return {
    title: ERROR_TITLE,
    message: `File: settings.json\nProblem: ${error.problem}\n${location}\nCorrect the file and restart PDF-Scrubber.\nYour settings have not been changed.`,
  };
}

function showConfigurationError(error, { dialog, app }) {
  if (!(error instanceof ConfigurationError)) return false;

  const { title, message } = formatConfigurationError(error);
  try {
    dialog.showErrorBox(title, message);
  } finally {
    app.exit(1);
  }
  return true;
}

module.exports = {
  ConfigurationError,
  formatConfigurationError,
  showConfigurationError,
};

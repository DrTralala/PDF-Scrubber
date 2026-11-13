const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  window: Object.freeze({ width: 1280, height: 860 }),
});

function validateSettings(value) {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['schemaVersion', 'window'])) {
    throw new Error('settings.json must contain only schemaVersion and window');
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`Unsupported settings schema version: ${String(value.schemaVersion)}`);
  }
  if (!isPlainRecord(value.window) || !hasExactKeys(value.window, ['width', 'height'])) {
    throw new Error('settings.json window must contain only width and height');
  }
  validateDimension(value.window.width, 'width', 760);
  validateDimension(value.window.height, 'height', 560);

  return Object.freeze({
    schemaVersion: 1,
    window: Object.freeze({ width: value.window.width, height: value.window.height }),
  });
}

function preflightPortableStorage(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new TypeError('Portable application root must be a non-empty path');
  }

  const root = path.resolve(rootPath);
  assertDirectoryPath(root, 'application root');
  const config = path.join(root, 'config');
  assertDirectoryPath(config, 'config directory');

  const profile = ensureChildDirectory(config, 'profile');
  const temp = ensureChildDirectory(config, 'temp');
  const logs = ensureChildDirectory(config, 'logs');
  const crashes = ensureChildDirectory(config, 'crashes');
  assertWritableDirectory(root, 'application root');
  assertWritableDirectory(profile, 'profile storage');
  assertWritableDirectory(temp, 'temporary storage');
  probeWritableDirectory(temp, 'temporary storage');

  return Object.freeze({ root, profile, temp, logs, crashes });
}

function preparePortableStorage(rootPath) {
  const paths = preflightPortableStorage(rootPath);
  const { root, profile, temp, logs, crashes } = paths;
  const settingsPath = path.join(root, 'settings.json');
  const existingSettings = tryReadSettings(settingsPath);
  let settings;
  if (existingSettings.found) {
    settings = existingSettings.settings;
  } else {
    settings = writeInitialSettings(settingsPath, temp);
  }

  return Object.freeze({ root, profile, temp, logs, crashes, settings });
}

function configurePortableApp(app, paths) {
  if (app === null || typeof app !== 'object'
    || typeof app.setPath !== 'function'
    || typeof app.setAppLogsPath !== 'function') {
    throw new TypeError('Electron app must support setPath and setAppLogsPath');
  }
  if (paths === null || typeof paths !== 'object') {
    throw new TypeError('Portable storage paths are required');
  }

  app.setPath('userData', paths.profile);
  app.setPath('sessionData', paths.profile);
  app.setPath('temp', paths.temp);
  app.setPath('crashDumps', paths.crashes);
  app.setAppLogsPath(paths.logs);
}

function validateDimension(value, name, minimum) {
  if (!Number.isInteger(value) || value < minimum || value > 16_384) {
    throw new Error(`settings.json window ${name} must be an integer from ${minimum} to 16384`);
  }
}

function assertWritableDirectory(directory, label) {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
  } catch (error) {
    throw storageFailure(
      `Portable ${label} is not writable. Move the complete PDF-Scrubber folder to a writable location; do not run it as administrator.`,
      error,
    );
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function assertDirectoryPath(targetPath, label) {
  const absolutePath = path.resolve(targetPath);
  const ancestors = [];
  let current = absolutePath;
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of ancestors.reverse()) {
    const stats = lstat(candidate, `${label} path`);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Portable ${label} is not a regular directory: ${candidate}`);
    }
  }
  return absolutePath;
}

function ensureChildDirectory(parentPath, name) {
  assertDirectoryPath(parentPath, 'storage parent');
  const childPath = path.join(parentPath, name);
  let stats;
  try {
    stats = fs.lstatSync(childPath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw new Error(`Could not inspect portable storage directory: ${childPath}`, { cause: error });
    }
    try {
      fs.mkdirSync(childPath, { mode: 0o700 });
    } catch (createError) {
      if (!isErrorCode(createError, 'EEXIST')) {
        throw storageFailure(`Could not create portable storage directory ${childPath}`, createError);
      }
    }
    stats = lstat(childPath, 'storage directory');
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Portable storage path is not a regular directory: ${childPath}`);
  }
  return childPath;
}

function lstat(targetPath, label) {
  let stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch (error) {
    throw new Error(`Could not inspect portable ${label}: ${targetPath}`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Portable ${label} must not be a symbolic link or reparse point: ${targetPath}`);
  }
  return stats;
}

function tryReadSettings(settingsPath) {
  let stats;
  try {
    stats = fs.lstatSync(settingsPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { found: false };
    throw new Error(`Could not inspect settings.json: ${settingsPath}`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`settings.json must be a regular file, not a link or reparse point: ${settingsPath}`);
  }

  let rawSettings;
  try {
    rawSettings = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read settings.json; the existing file was not changed: ${settingsPath}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    throw new Error(`settings.json is malformed and was not changed: ${settingsPath}`, { cause: error });
  }
  try {
    return { found: true, settings: validateSettings(parsed) };
  } catch (error) {
    throw new Error(`settings.json is invalid and was not changed: ${settingsPath}`, { cause: error });
  }
}

function probeWritableDirectory(directory, label) {
  const probePath = path.join(directory, `.pdf-scrubber-write-test-${process.pid}-${randomUUID()}`);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, 'pdf-scrubber storage probe\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(probePath);
    created = false;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    if (created) {
      try {
        fs.unlinkSync(probePath);
      } catch {
        // A failed probe is only removed when it is the file just created above.
      }
    }
    throw storageFailure(
      `Portable ${label} is not writable. Move the complete PDF-Scrubber folder to a writable location; do not run it as administrator.`,
      error,
    );
  }
}

function writeInitialSettings(settingsPath, tempDirectory) {
  const candidatePath = path.join(
    tempDirectory,
    `.pdf-scrubber-settings-${process.pid}-${randomUUID()}.tmp`,
  );
  let descriptor;
  let candidateOwned = false;
  try {
    descriptor = fs.openSync(candidatePath, 'wx', 0o600);
    candidateOwned = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    // The app's single-instance lock is acquired before this bootstrap is called.
    // Recheck the destination so an existing user file is never intentionally replaced.
    const destination = tryReadSettings(settingsPath);
    if (destination.found) {
      fs.unlinkSync(candidatePath);
      candidateOwned = false;
      return destination.settings;
    }
    fs.renameSync(candidatePath, settingsPath);
    candidateOwned = false;
    return DEFAULT_SETTINGS;
  } catch (error) {
    throw storageFailure(`Could not initialise settings.json at ${settingsPath}; no existing settings were changed`, error);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the initialization failure.
      }
    }
    if (candidateOwned) {
      try {
        fs.unlinkSync(candidatePath);
      } catch {
        // Keep cleanup limited to this invocation's unique candidate file.
      }
    }
  }
}

function storageFailure(message, cause) {
  return new Error(message, { cause });
}

function isErrorCode(error, code) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

module.exports = {
  DEFAULT_SETTINGS,
  validateSettings,
  preflightPortableStorage,
  preparePortableStorage,
  configurePortableApp,
};

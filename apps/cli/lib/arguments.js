const PORT_ERROR = 'Port must be an integer from 1 to 65535';

/**
 * @typedef {{
 *   command: 'run' | 'help' | 'version',
 *   port: number,
 *   explicitPort: boolean,
 *   openBrowser: boolean,
 * }} ParsedArguments
 */

/**
 * @param {readonly string[]} argv
 * @returns {ParsedArguments}
 */
export function parseArguments(argv) {
  /** @type {ParsedArguments} */
  const parsed = {
    command: 'run',
    port: 5173,
    explicitPort: false,
    openBrowser: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (parsed.command !== 'run') {
      throw new Error(`Unexpected argument after --${parsed.command}: ${argument}`);
    }

    if (argument === '--no-open') {
      parsed.openBrowser = false;
      continue;
    }

    if (argument === '--help') {
      parsed.command = 'help';
      continue;
    }

    if (argument === '--version') {
      parsed.command = 'version';
      continue;
    }

    if (argument === '--port') {
      if (parsed.explicitPort) {
        throw new Error('Port may only be specified once');
      }

      const value = argv[index + 1];
      const port = Number(value);
      if (value === undefined || value.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(PORT_ERROR);
      }

      parsed.port = port;
      parsed.explicitPort = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return parsed;
}

export function usage() {
  return 'Usage: pdf-scrubber [--no-open] [--port <number>]';
}

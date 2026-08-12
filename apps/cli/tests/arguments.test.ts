import { describe, expect, test } from 'vitest';

// @ts-expect-error The published runtime is intentionally plain JavaScript with JSDoc types.
import { parseArguments, usage } from '../lib/arguments.js';

describe('parseArguments', () => {
  test('uses fixed run defaults', () => {
    expect(parseArguments([])).toEqual({
      command: 'run',
      port: 5173,
      explicitPort: false,
      openBrowser: true,
    });
  });

  test('disables browser opening', () => {
    expect(parseArguments(['--no-open'])).toMatchObject({ openBrowser: false });
  });

  test('accepts an explicit port', () => {
    expect(parseArguments(['--port', '6000'])).toMatchObject({
      port: 6000,
      explicitPort: true,
    });
  });

  test('selects the help command', () => {
    expect(parseArguments(['--help']).command).toBe('help');
  });

  test('selects the version command', () => {
    expect(parseArguments(['--version']).command).toBe('version');
  });

  test.each(['abc', '1.5', '0', '65536'])('rejects invalid port %s', (port) => {
    expect(() => parseArguments(['--port', port])).toThrow(
      'Port must be an integer from 1 to 65535',
    );
  });

  test('rejects a missing port value', () => {
    expect(() => parseArguments(['--port'])).toThrow(
      'Port must be an integer from 1 to 65535',
    );
  });

  test('rejects duplicate port options', () => {
    expect(() => parseArguments(['--port', '6000', '--port', '6001'])).toThrow(
      'Port may only be specified once',
    );
  });

  test('rejects unknown arguments', () => {
    expect(() => parseArguments(['--unknown'])).toThrow('Unknown argument: --unknown');
  });

  test.each(['--help', '--version'])('rejects arguments following %s', (command) => {
    expect(() => parseArguments([command, '--no-open'])).toThrow(
      `Unexpected argument after ${command}: --no-open`,
    );
  });
});

test('usage shows the supported invocation', () => {
  expect(usage()).toContain('Usage: pdf-scrubber [--no-open] [--port <number>]');
});

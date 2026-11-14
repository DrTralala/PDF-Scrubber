import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { runHandleDiagnostic } from './desktop-handle-diagnostic';

test('searches only the unique task-root basename and filters output to matching paths and PID headers', async () => {
  const taskRoot = join(tmpdir(), 'pdf-scrubber-desktop-smoke-abc123');
  const applicationRoot = join(taskRoot, 'extracted', 'PDF-Scrubber');
  const matchingPath = join(applicationRoot, 'config', 'runtime', 'PDF-Scrubber.exe');
  const calls: Array<{ executable: string; arguments: readonly string[]; options: unknown }> = [];

  const diagnostic = await runHandleDiagnostic(
    join(tmpdir(), 'handle', 'Handle64.exe'),
    applicationRoot,
    async (executable, arguments_, options) => {
      calls.push({ executable, arguments: arguments_, options });
      return {
        stdout: [
          'Handle v5.0 - Handle viewer',
          'node.exe pid: 4100',
          `  78: File  ${matchingPath}`,
          'other.exe pid: 4101',
          '  20: File  C:\\Users\\runner\\Desktop\\unrelated.pdf',
        ].join('\n'),
        stderr: 'error mentioning pdf-scrubber-desktop-smoke-abc123 is not a Handle match',
      };
    },
  );

  expect(calls).toEqual([{
    executable: join(tmpdir(), 'handle', 'Handle64.exe'),
    arguments: ['-a', 'pdf-scrubber-desktop-smoke-abc123'],
    options: { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
  }]);
  expect(diagnostic).toEqual({
    status: 'completed',
    searchTerm: 'pdf-scrubber-desktop-smoke-abc123',
    matchingLinesTruncated: false,
    matchingLines: [
      'node.exe pid: 4100',
      `78: File  ${matchingPath}`,
    ],
  });
  expect(calls[0]?.arguments).not.toContain('-c');
  expect(calls[0]?.arguments).not.toContain('-nobanner');
});

test('rejects paths outside the unique top-level smoke extraction before invoking Handle', async () => {
  let invoked = false;

  await expect(runHandleDiagnostic(
    join(tmpdir(), 'handle', 'Handle64.exe'),
    join(tmpdir(), 'ordinary-directory', 'extracted', 'PDF-Scrubber'),
    async () => {
      invoked = true;
      return { stdout: '', stderr: '' };
    },
  )).rejects.toThrow(/pdf-scrubber-desktop-smoke/i);
  expect(invoked).toBe(false);
});

test('reports an empty filtered result without implying a root cause', async () => {
  const applicationRoot = join(tmpdir(), 'pdf-scrubber-desktop-smoke-xyz789', 'extracted', 'PDF-Scrubber');
  const diagnostic = await runHandleDiagnostic(
    join(tmpdir(), 'handle', 'Handle64.exe'),
    applicationRoot,
    async () => ({ stdout: 'No matching handles found.', stderr: '' }),
  );

  expect(diagnostic).toEqual({
    status: 'completed',
    searchTerm: 'pdf-scrubber-desktop-smoke-xyz789',
    matchingLinesTruncated: false,
    matchingLines: [],
  });
});

test('caps reported Handle output and marks matching lines as truncated', async () => {
  const searchTerm = 'pdf-scrubber-desktop-smoke-cap123';
  const applicationRoot = join(tmpdir(), searchTerm, 'extracted', 'PDF-Scrubber');
  const stdout = Array.from({ length: 70 }, (_unused, index) =>
    `Handle64.exe pid: ${index + 1} File ${searchTerm}\\file-${index}.pdf`,
  ).join('\n');
  const diagnostic = await runHandleDiagnostic(
    join(tmpdir(), 'handle', 'Handle64.exe'),
    applicationRoot,
    async () => ({ stdout, stderr: '' }),
  );

  expect(diagnostic.matchingLines).toHaveLength(64);
  expect(diagnostic.matchingLinesTruncated).toBe(true);
});

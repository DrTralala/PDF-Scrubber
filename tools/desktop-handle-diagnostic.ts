import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const HANDLE_TIMEOUT_MS = 10_000;
const HANDLE_MAX_BUFFER = 64 * 1024;
const MAX_REPORTED_LINES = 64;
const MAX_REPORTED_LINE_LENGTH = 2_048;

export type HandleDiagnosticResult = Readonly<{
  status: 'completed';
  searchTerm: string;
  matchingLines: readonly string[];
  matchingLinesTruncated: boolean;
}>;

export type HandleExecutionOptions = Readonly<{
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
}>;

export type HandleExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: HandleExecutionOptions,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export async function runHandleDiagnostic(
  executable: string,
  applicationRoot: string,
  execute: HandleExecutor = executeHandle,
): Promise<HandleDiagnosticResult> {
  if (!isAbsolute(executable)) throw new Error('The configured Handle executable path must be absolute.');
  const searchTerm = getSmokeTaskRootBasename(applicationRoot);
  const output = await execute(executable, ['-a', searchTerm], {
    timeout: HANDLE_TIMEOUT_MS,
    maxBuffer: HANDLE_MAX_BUFFER,
    windowsHide: true,
  });

  const selected = selectMatchingLines(output.stdout, searchTerm);
  return {
    status: 'completed',
    searchTerm,
    ...selected,
  };
}

function getSmokeTaskRootBasename(applicationRoot: string): string {
  if (!isAbsolute(applicationRoot)) throw new Error('The portable smoke extraction path must be absolute.');
  const resolvedRoot = resolve(applicationRoot);
  const extractionDirectory = dirname(resolvedRoot);
  const taskRoot = dirname(extractionDirectory);
  const taskRootBasename = basename(taskRoot);
  if (
    basename(resolvedRoot).toLowerCase() !== 'pdf-scrubber' ||
    basename(extractionDirectory).toLowerCase() !== 'extracted' ||
    !/^pdf-scrubber-desktop-smoke-[a-z0-9][a-z0-9_-]*$/i.test(taskRootBasename) ||
    normalisePath(dirname(taskRoot)) !== normalisePath(resolve(tmpdir()))
  ) {
    throw new Error('Handle diagnostics are limited to the unique top-level pdf-scrubber-desktop-smoke-* extraction.');
  }
  return taskRootBasename;
}

function selectMatchingLines(
  output: string,
  searchTerm: string,
): Readonly<{ matchingLines: readonly string[]; matchingLinesTruncated: boolean }> {
  const selected: string[] = [];
  const seen = new Set<string>();
  let pendingProcessHeader: string | undefined;
  let truncated = false;
  const searchTermLower = searchTerm.toLowerCase();

  const add = (line: string): void => {
    const trimmedLine = line.trim();
    const boundedLine = trimmedLine.slice(0, MAX_REPORTED_LINE_LENGTH);
    if (trimmedLine.length > MAX_REPORTED_LINE_LENGTH) truncated = true;
    if (boundedLine.length === 0 || seen.has(boundedLine)) return;
    if (selected.length >= MAX_REPORTED_LINES) {
      truncated = true;
      return;
    }
    seen.add(boundedLine);
    selected.push(boundedLine);
  };

  for (const line of output.split(/\r?\n/)) {
    const processHeader = parseProcessHeader(line);
    if (line.toLowerCase().includes(searchTermLower)) {
      if (processHeader === undefined && pendingProcessHeader !== undefined) add(pendingProcessHeader);
      add(line);
      pendingProcessHeader = undefined;
    } else if (processHeader !== undefined) {
      pendingProcessHeader = processHeader;
    }
  }

  return { matchingLines: selected, matchingLinesTruncated: truncated };
}

function parseProcessHeader(line: string): string | undefined {
  const match = /^\s*([^\s:]+)\s+pid:\s*(\d+)(?:\s|$)/i.exec(line);
  if (match === null) return undefined;
  return `${match[1]} pid: ${match[2]}`;
}

function normalisePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '').toLowerCase();
}

function executeHandle(
  executable: string,
  arguments_: readonly string[],
  options: HandleExecutionOptions,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, [...arguments_], {
      ...options,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

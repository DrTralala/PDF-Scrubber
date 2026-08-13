import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  PROJECT_VALIDATION_BASH_ENTRIES,
  applyProjectValidationBashPolicy,
} from './project-validation-policy';

type JsonObject = Record<string, unknown>;

const projectRoot = resolve(import.meta.dirname, '..');

const EXPECTED_BASH_ENTRIES = [
  ['*', 'ask'],
  ['**', 'ask'],
  ['node --version', 'allow'],
  ['npm --version', 'allow'],
  ['npm ls --depth=0', 'allow'],
  ["ss -ltnp '( sport = :5173 )'", 'allow'],
  ["ss -ltn '( sport = :5173 )'", 'allow'],
  ['npm run build:fixtures', 'allow'],
  ['npm run typecheck', 'allow'],
  ['npm run test:web:unit', 'allow'],
  ['npm run test:web:unit -- *', 'allow'],
  ['npm run build:web', 'allow'],
  ['npm run test:web', 'allow'],
  ['npm run test:web -- *', 'allow'],
  ['npm run test:web -- --full', 'allow'],
  ['npm run test:web -- --full *', 'allow'],
  ['npm run test:m0', 'allow'],
  ['npm start -- --host 127.0.0.1', 'allow'],
  ['npm start -- --host 127.0.0.1 --strictPort', 'allow'],
  ['npm start -- --host ::1', 'allow'],
  ['npm start -- --host ::1 --strictPort', 'allow'],
  ['npm start -- --host 0.0.0.0', 'allow'],
  ['npm start -- --host 0.0.0.0 --strictPort', 'allow'],
  ['sha256sum tests/*/document.pdf', 'allow'],
  ['file tests/*/document.pdf', 'allow'],
  ['pdfinfo tests/*/document.pdf', 'allow'],
  ['pdffonts tests/*/document.pdf', 'allow'],
  ['pdftotext tests/*/document.pdf -', 'allow'],
  ['opencode debug config', 'allow'],
  ['*<*', 'ask'],
  ['*>*', 'ask'],
] as const;

type BashAction = 'allow' | 'ask' | 'deny';

function matchesOpenCodePattern(command: string, pattern: string): boolean {
  const normalisedCommand = command.replaceAll('\\', '/');
  const normalisedPattern = pattern.replaceAll('\\', '/');
  let expression = normalisedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (expression.endsWith(' .*')) expression = `${expression.slice(0, -3)}( .*)?`;
  return new RegExp(`^${expression}$`, 's').test(normalisedCommand);
}

function evaluateBashPolicy(
  command: string,
  entries: readonly (readonly [string, BashAction])[],
): BashAction {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && matchesOpenCodePattern(command, entry[0])) return entry[1];
  }
  return 'ask';
}

function asJsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

test('project OpenCode policy asks by default and narrowly allows validation commands', () => {
  const bash = Object.fromEntries(PROJECT_VALIDATION_BASH_ENTRIES);
  const expectedAllowedPatterns = EXPECTED_BASH_ENTRIES
    .filter(([, action]) => action === 'allow')
    .map(([pattern]) => pattern);

  expect(Object.entries(bash)).toEqual(EXPECTED_BASH_ENTRIES);
  expect(PROJECT_VALIDATION_BASH_ENTRIES).toEqual(EXPECTED_BASH_ENTRIES);
  expect(Object.keys(bash)).toEqual(EXPECTED_BASH_ENTRIES.map(([pattern]) => pattern));
  expect(Object.keys(bash).filter((pattern) => bash[pattern] === 'allow'))
    .toEqual(expectedAllowedPatterns);
  expect(Object.keys(bash)[0]).toBe('*');
  expect(bash['*']).toBe('ask');
  expect(Object.entries(bash).slice(-2)).toEqual([['*<*', 'ask'], ['*>*', 'ask']]);
});

test('effective merged Bash policy resets inherited allows before project validation allows', () => {
  const projectBash = Object.fromEntries(PROJECT_VALIDATION_BASH_ENTRIES);
  const inheritedBash = {
    '*': 'allow',
    'agent-browser *': 'allow',
    'find *': 'allow',
    'mkdir *': 'allow',
    'npm view *': 'allow',
    'rg *': 'allow',
    'pdftotext *': 'allow',
    'opencode debug config': 'allow',
  } satisfies Record<string, BashAction>;
  const mergedBash = {
    ...inheritedBash,
    ...projectBash,
  };
  const mergedEntries = Object.entries(mergedBash) as [string, BashAction][];

  expect(mergedEntries.map(([pattern]) => pattern)).toEqual([
    ...Object.keys(inheritedBash),
    ...Object.keys(projectBash).filter((pattern) => !(pattern in inheritedBash)),
  ]);
  const effectiveConfig = {
    permission: {
      edit: 'allow',
      bash: mergedBash,
    },
  };
  applyProjectValidationBashPolicy(effectiveConfig);
  const effectivePermission = asJsonObject(effectiveConfig.permission, 'effective permission');
  const effectiveBash = asJsonObject(effectivePermission.bash, 'effective Bash permission');
  const effectiveEntries = Object.entries(effectiveBash) as [string, BashAction][];
  expect(effectivePermission.edit).toBe('allow');
  expect(effectiveEntries).toEqual(EXPECTED_BASH_ENTRIES);
  expect(matchesOpenCodePattern('any non-empty Bash command', '**')).toBe(true);

  for (const command of [
    'agent-browser open https://example.com',
    'find . -type f',
    'mkdir scratch',
    'npm view vite version',
    'rg TODO .',
    'pdftotext README.pdf -',
  ]) {
    expect(evaluateBashPolicy(command, effectiveEntries), command).toBe('ask');
  }

  for (const command of [
    'npm run typecheck',
    'npm run test:web -- --full committed-pdf-suites.spec.ts',
    'pdftotext tests/3/document.pdf -',
    'opencode debug config',
  ]) {
    expect(evaluateBashPolicy(command, effectiveEntries), command).toBe('allow');
  }
  expect(evaluateBashPolicy('npm run typecheck > output.log', effectiveEntries)).toBe('ask');
});

test('release documentation requires full committed PDF suites', async () => {
  const checks = await readFile(resolve(
    projectRoot,
    '.opencode/skills/pdf-scrubber-run-validate/references/automated-checks.md',
  ), 'utf8');
  const readme = await readFile(resolve(projectRoot, 'README.md'), 'utf8');

  expect(checks).toContain("ss -ltnp '( sport = :5173 )'");
  expect(checks).toContain('Any listener on port 5173 is a blocker');
  expect(checks).toContain('Playwright uses `http://[::1]:5173`');
  expect(checks).toContain('starts `npm start -- --host ::1 --mode test`');
  expect(checks).toContain('`reuseExistingServer: false`');
  expect(checks).toContain('Playwright owns its test-mode server');
  expect(checks).toContain('empty attempted-remote-request list');
  expect(checks).toContain(
    'These automated assertions remain authoritative when agent-browser cannot observe an internal invariant directly.',
  );
  expect(checks).toContain(
    'After `test:web -- --full`, verify port 5173 is free before continuing. Repeat that check after `test:m0`.',
  );
  expect(checks).toContain('Fresh `docs/research/m0-results.md` says `## Decision: GO`');
  expect(checks).toMatch(/^npm run test:web -- --full$/m);
  expect(checks).toMatch(/`npm run test:web` runs the existing browser tests plus committed Suite 1\./);
  expect(checks).toMatch(/must run `npm run test:web -- --full` so all three committed suites are covered\./);

  expect(readme).toMatch(/^# Routine: existing browser tests plus committed Suite 1$/m);
  expect(readme).toMatch(/^npm run test:web$/m);
  expect(readme).toMatch(/^# Full: existing browser tests plus committed Suites 1–3$/m);
  expect(readme).toMatch(/^npm run test:web -- --full$/m);
  expect(readme).toContain('Port 5173 must be free before either browser command');
  expect(readme).toContain('strict-port test server');
  expect(checks).toContain('all three committed suites');
  expect(readme).toContain('synthetic');
  expect(readme).toContain('manifest/hash verified');
  expect(readme).toContain('not regenerated during tests');
  expect(readme).toContain('removes the downloads afterwards');
});

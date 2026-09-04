import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  assertBuiltAssetClosure,
  assertCliPackageFiles,
  packageFilesFromReport,
  packageReportEntry,
} from './cli-package';

const projectRoot = resolve(import.meta.dirname, '..');
const packageRoot = resolve(projectRoot, 'apps/cli');

const output = execFileSync(
  'npm',
  ['pack', '--workspace', 'pdf-scrubber', '--dry-run', '--json', '--ignore-scripts'],
  {
    cwd: projectRoot,
    encoding: 'utf8',
  },
);
const report: unknown = JSON.parse(output);
const entry = packageReportEntry(report);

if (entry.name !== 'pdf-scrubber' || entry.version !== '1.1.0') {
  throw new Error(`Unexpected CLI package identity: ${entry.name}@${entry.version}`);
}

const paths = packageFilesFromReport(report);
assertCliPackageFiles(paths);

const executable = entry.files.find((file) => file.path === 'bin/pdf-scrubber.js');
if (executable?.mode !== undefined && (executable.mode & 0o111) === 0) {
  throw new Error('bin/pdf-scrubber.js is not executable in the npm package report');
}

await assertBuiltAssetClosure(packageRoot, paths);
console.log('CLI package contents: ok');

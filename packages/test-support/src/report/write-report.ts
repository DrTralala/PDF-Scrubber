import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { M0Report } from './results';

export function serialiseResults(report: M0Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function thresholdLine(report: M0Report, renderer: 'pdfjs' | 'poppler'): string {
  const threshold = report.visualThresholds[renderer];
  return `- ${renderer}: mismatch <= ${String(threshold.mismatchRatioThreshold)}, `
    + `SSIM >= ${String(threshold.ssimThreshold)}, separation `
    + `${threshold.separatesPerturbation ? 'proved' : 'not proved'}`;
}

export function renderMarkdownReport(report: M0Report): string {
  const failed = report.cases.filter(({ status }) => status === 'fail').map(({ id }) => id);
  const editable = report.cases
    .filter(({ observed }) => observed.kind === 'capability')
    .map(({ id, observed }) => `${id}: ${observed.kind === 'capability' ? observed.capability : ''}`);
  return [
    '# M0 PDF Mutation Feasibility Results',
    '',
    `## Decision: ${report.decision.decision}`,
    '',
    ...(report.decision.reasons.length === 0
      ? ['- All mandatory evidence gates passed.']
      : report.decision.reasons.map((reason) => `- ${reason}`)),
    '',
    '## Dependency and capability decision',
    '',
    `- Candidate object graph/serializer: ${failed.length === 0 ? 'accepted' : `rejected; failed fixtures: ${failed.join(', ')}`}`,
    '- Custom tokeniser: Tj, TJ, single-quote, and double-quote text operators; inline images and unsupported filters are explicit exclusions.',
    '- Shaper/embedder: Noto Sans Latin/Arabic through HarfBuzz and subset embedding; unavailable or prohibited embedding is read-only.',
    `- Independent consumers: PDF.js ${report.dependencies['pdfjs-dist'] ?? 'unknown'}, Chromium ${report.environment.chromium}, Poppler ${report.environment.poppler}.`,
    `- Editable classes: ${editable.join('; ')}.`,
    `- Measured browser limits: ${JSON.stringify(report.resourceLimits)}.`,
    '- Visual thresholds:',
    thresholdLine(report, 'pdfjs'),
    thresholdLine(report, 'poppler'),
    `- Determinism: ${report.cases.every(({ evidence }) => evidence.deterministicOutput || evidence.failureClosed) ? 'output hash evidence passed' : 'failed'}.`,
    `- Licences: ${report.licences.join(', ')}; ${report.excludedDependencies.join(', ')}.`,
    `- Decision: ${report.decision.decision}.`,
    '',
    '## Corpus evidence',
    '',
    '| Fixture | Expected | Observed | Status |',
    '|---|---|---|---|',
    ...report.cases.map((item) => [
      item.id,
      item.expected.kind === 'capability' ? item.expected.capability : item.expected.kind,
      item.observed.kind === 'capability' ? item.observed.capability : item.observed.kind,
      item.status,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
    '',
  ].join('\n');
}

export async function writeReport(
  report: M0Report,
  jsonPath: string,
  markdownPath: string,
): Promise<void> {
  await Promise.all([
    mkdir(dirname(jsonPath), { recursive: true }),
    mkdir(dirname(markdownPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(jsonPath, serialiseResults(report), 'utf8'),
    writeFile(markdownPath, renderMarkdownReport(report), 'utf8'),
  ]);
}

import './style.css';

import type {
  AnalysePageResult,
  ApplyReplacementResult,
  OpenDocumentResult,
  ReplacementPreviewResult,
  ValidationEvidence,
} from '@pdf-editor/worker-protocol';
import type { EngineLimits, EngineResourceUsage } from '@pdf-editor/pdf-engine';

import { WorkerClient, WorkerClientError } from './worker-client';

type BrowserShapedRun = Readonly<{
  glyphs: readonly unknown[];
  direction: string;
}>;

const fixtureUrls = Object.freeze({
  simple: new URL('../../../fixtures/generated/01-simple-tj.pdf', import.meta.url),
  shared: new URL('../../../fixtures/generated/18-shared-form-xobject.pdf', import.meta.url),
  malformed: new URL('../../../fixtures/generated/26-malformed-stream.pdf', import.meta.url),
  overLimit: new URL('../../../fixtures/generated/27-decompression-abuse.pdf', import.meta.url),
});

const output = document.querySelector<HTMLOutputElement>('[data-testid="worker-result"]');
if (output === null) throw new Error('Worker result output is missing');

const client = new WorkerClient();
output.value = await client.request<string>('ping', null);
window.__m0WorkerObserved = true;
window.__m0ResourceProbe = (
  bytes: ArrayBuffer,
  limits: EngineLimits,
  analyse: boolean,
  validate = false,
): Promise<EngineResourceUsage & Readonly<{ analysedSpans: number; durationMs: number }>> =>
  client.request(
    'resourceProbe',
    { bytes, limits, analyse, validate },
    [bytes],
    { timeoutMs: limits.maxProcessingMs },
  );

async function fetchFixture(url: URL): Promise<Readonly<{
  source: Uint8Array;
  sourceCopy: Uint8Array;
  input: ArrayBuffer;
}>> {
  const buffer = await fetch(url).then((response) => response.arrayBuffer());
  const source = new Uint8Array(buffer as ArrayBuffer);
  return Object.freeze({ source, sourceCopy: source.slice(), input: source.slice().buffer });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function openFixture(
  activeClient: WorkerClient,
  url: URL,
  timeoutMs?: number,
): Promise<Readonly<{
  opened: OpenDocumentResult;
  source: Uint8Array;
  sourceCopy: Uint8Array;
  input: ArrayBuffer;
}>> {
  const fixture = await fetchFixture(url);
  const opened = await activeClient.request<OpenDocumentResult>(
    'openDocument',
    { bytes: fixture.input },
    [fixture.input],
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  return Object.freeze({ opened, ...fixture });
}

async function prepareReplacement(
  activeClient: WorkerClient,
  opened: OpenDocumentResult,
  replacement: string,
): Promise<Readonly<{
  page: AnalysePageResult;
  spanKey: string;
  preview: ReplacementPreviewResult;
}>> {
  const page = await activeClient.request<AnalysePageResult>(
    'analysePage',
    { pageIndex: 0 },
    [],
    { documentId: opened.documentId, revision: opened.revision },
  );
  const span = page.spans[0];
  if (span === undefined) throw new Error('Fixture has no analysable text span');
  const spanKey = page.spanKeys[0];
  if (spanKey === undefined) throw new Error('Fixture span has no stable address key');
  const preview = await activeClient.request<ReplacementPreviewResult>(
    'previewReplacement',
    { spanKey, replacement, acceptSubstitution: true },
    [],
    { documentId: opened.documentId, revision: opened.revision },
  );
  return Object.freeze({ page, spanKey, preview });
}

async function applyPrepared(
  activeClient: WorkerClient,
  opened: OpenDocumentResult,
  prepared: Awaited<ReturnType<typeof prepareReplacement>>,
  replacement: string,
  revision: number = opened.revision,
): Promise<ApplyReplacementResult> {
  return activeClient.request<ApplyReplacementResult>(
    'applyReplacement',
    { spanKey: prepared.spanKey, replacement, acceptSubstitution: true },
    [],
    {
      documentId: opened.documentId,
      revision,
      preconditions: prepared.preview.preconditions,
    },
  );
}

function failure(error: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ok: false,
    code: error instanceof WorkerClientError ? error.code : 'INTERNAL_FAILURE',
    message: error instanceof Error ? error.message : 'Unknown failure',
    hasBytes: false,
  });
}

async function runScenario(name: string): Promise<Readonly<Record<string, unknown>>> {
  try {
    if (name === 'timeout') {
      const before = client.workerGeneration;
      let timeoutError: unknown;
      const fixture = await fetchFixture(fixtureUrls.simple);
      try {
        await client.request(
          'openDocument',
          { bytes: fixture.input },
          [fixture.input],
          { timeoutMs: 0 },
        );
      } catch (error) {
        timeoutError = error;
      }
      let sessionRequestRejected = false;
      try {
        await client.request('analysePage', { pageIndex: 0 }, [], {
          documentId: 'timed-out',
          revision: 0,
        });
      } catch {
        sessionRequestRejected = true;
      }
      const reopened = await openFixture(client, fixtureUrls.simple);
      await client.request('closeDocument', null, [], {
        documentId: reopened.opened.documentId,
        revision: 0,
      });
      return Object.freeze({
        ...failure(timeoutError),
        sessionRequestRejected,
        newDocumentOpened: true,
        workerGenerationBefore: before,
        workerGenerationAfter: client.workerGeneration,
      });
    }

    const url = name === 'shared'
      ? fixtureUrls.shared
      : name === 'malformed'
        ? fixtureUrls.malformed
        : name === 'over-limit'
          ? fixtureUrls.overLimit
          : fixtureUrls.simple;
    const fixture = await openFixture(client, url);
    const prepared = await prepareReplacement(client, fixture.opened, 'Edited 01');

    if (name === 'stale') {
      await applyPrepared(client, fixture.opened, prepared, 'Edited 01', 1);
      throw new Error('Stale replacement unexpectedly succeeded');
    }
    const applied = await applyPrepared(client, fixture.opened, prepared, 'Edited 01');
    if (name === 'validation-failure') {
      await client.request('exportDocument', null, [], {
        documentId: fixture.opened.documentId,
        revision: fixture.opened.revision,
        preconditions: { validatedCandidateHash: applied.candidateHash },
      });
      throw new Error('Unvalidated export unexpectedly succeeded');
    }

    const checked = await client.request<ValidationEvidence>('validateExport', null, [], {
      documentId: fixture.opened.documentId,
      revision: applied.revision,
    });
    if (!checked.valid) {
      return Object.freeze({
        ok: false,
        code: 'VALIDATION_FAILURE',
        message: 'Runtime validation rejected the candidate',
        hasBytes: false,
        checks: checked.checks,
      });
    }
    const exported = await client.request<Readonly<{ bytes: ArrayBuffer }>>(
      'exportDocument',
      null,
      [],
      {
        documentId: fixture.opened.documentId,
        revision: applied.revision,
        preconditions: { validatedCandidateHash: checked.candidateHash },
      },
    );
    let secondExportCode: string | null = null;
    try {
      await client.request('exportDocument', null, [], {
        documentId: fixture.opened.documentId,
        revision: applied.revision,
        preconditions: { validatedCandidateHash: checked.candidateHash },
      });
    } catch (error) {
      secondExportCode = error instanceof WorkerClientError ? error.code : 'INTERNAL_FAILURE';
    }
    await client.request('closeDocument', null, [], {
      documentId: fixture.opened.documentId,
      revision: applied.revision,
    });
    return Object.freeze({
      ok: true,
      revision: applied.revision,
      valid: checked.valid,
      exportBytes: exported.bytes.byteLength,
      sourceUnchanged: equalBytes(fixture.source, fixture.sourceCopy),
      inputTransferred: fixture.input.byteLength === 0,
      secondExportCode,
    });
  } catch (error) {
    return failure(error);
  }
}

const parameters = new URLSearchParams(location.search);
if (parameters.has('shape')) {
  const shapeOutput = document.querySelector<HTMLOutputElement>('[data-testid="shape-result"]');
  if (shapeOutput === null) throw new Error('Shape result output is missing');
  const fontUrl = new URL(
    '../../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
    import.meta.url,
  );
  const fontBytes = await fetch(fontUrl).then((response) => response.arrayBuffer());
  const shaped = await client.request<BrowserShapedRun>(
    'shapeText',
    { fontBytes, text: 'office' },
    [fontBytes],
  );
  shapeOutput.value = `office:${shaped.glyphs.length}:${shaped.direction}`;
  window.__m0ShapingObserved = true;
}

const scenario = parameters.get('scenario');
if (scenario !== null) {
  const sessionOutput = document.querySelector<HTMLOutputElement>(
    '[data-testid="session-result"]',
  );
  if (sessionOutput === null) throw new Error('Session result output is missing');
  sessionOutput.value = JSON.stringify(await runScenario(scenario));
  window.__m0SessionObserved = true;
}

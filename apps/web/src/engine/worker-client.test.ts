import type {
  EngineRequest,
  OpenDocumentResult,
} from '@pdf-editor/worker-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerTransport } from './worker-client';

class FakeWorker extends EventTarget {
  readonly posts: Array<{ value: unknown; transfer: Transferable[] }> = [];
  terminated = false;

  postMessage(value: unknown, transfer: Transferable[]): void {
    this.posts.push({ value, transfer });
  }

  respond(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  fail(message: string): void {
    this.dispatchEvent(new ErrorEvent('error', { message }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkerTransport', () => {
  it('correlates a response and forwards the exact transfer list', async () => {
    const worker = new FakeWorker();
    const client = new WorkerTransport(() => worker as unknown as Worker);
    const buffer = Uint8Array.of(1).buffer;

    const pending = client.request<'worker:ready'>('ping', null, [buffer], {});
    const request = worker.posts[0]!.value as EngineRequest;
    expect(worker.posts[0]!.transfer).toEqual([buffer]);

    worker.respond({
      requestId: request.requestId,
      operation: 'ping',
      ok: true,
      value: 'worker:ready',
    });

    await expect(pending).resolves.toBe('worker:ready');
  });

  it('maps worker failures and rejects every pending request', async () => {
    const worker = new FakeWorker();
    const client = new WorkerTransport(() => worker as unknown as Worker);
    const first = client.request('ping', null, [], {});
    const second = client.request('ping', null, [], {});

    worker.fail('worker crashed');

    await expect(first).rejects.toMatchObject({
      code: 'INTERNAL_FAILURE',
      message: 'worker crashed',
    });
    await expect(second).rejects.toMatchObject({
      code: 'INTERNAL_FAILURE',
      message: 'worker crashed',
    });
    expect(worker.terminated).toBe(true);
  });

  it('terminates after timeout and recreates only for the next open', async () => {
    vi.useFakeTimers();
    const first = new FakeWorker();
    const second = new FakeWorker();
    let factoryCalls = 0;
    const client = new WorkerTransport(
      () => [first, second][factoryCalls++]! as unknown as Worker,
    );

    const timedOut = client.request('ping', null, [], { timeoutMs: 5 });
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: {
        resource: 'processingTime',
        limit: 5,
      },
    });
    await vi.advanceTimersByTimeAsync(5);
    await timeoutExpectation;
    await expect(
      client.request('analysePage', { pageIndex: 0 }, [], {}),
    ).rejects.toThrow(/openDocument/);

    const reopened = client.request<OpenDocumentResult>(
      'openDocument',
      { bytes: new ArrayBuffer(0) },
      [],
      {},
    );
    const request = second.posts[0]!.value as EngineRequest;
    second.respond({
      requestId: request.requestId,
      operation: 'openDocument',
      ok: true,
      value: { documentId: 'd2', fingerprint: 'f2', revision: 0 },
    });

    await expect(reopened).resolves.toMatchObject({ documentId: 'd2' });
    expect(factoryCalls).toBe(2);
  });
});

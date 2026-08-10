import type { EngineErrorCode, EngineErrorDescriptor } from '@pdf-editor/pdf-engine';

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerSuccess = Readonly<{ requestId: string; ok: true; value: unknown }>;
type WorkerFailure = Readonly<{
  requestId: string;
  ok: false;
  error: EngineErrorDescriptor;
}>;
type WorkerResponse = WorkerSuccess | WorkerFailure;

export type WorkerRequestEnvelope = Readonly<{
  documentId?: string;
  revision?: number;
  preconditions?: unknown;
  timeoutMs?: number;
}>;

export class WorkerClientError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(descriptor: EngineErrorDescriptor) {
    super(descriptor.message);
    this.name = 'WorkerClientError';
    this.code = descriptor.code;
    if (descriptor.details !== undefined) this.details = descriptor.details;
  }
}

export class WorkerClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #objectUrls = new Set<string>();
  readonly #maxProcessingMs: number;
  #worker: Worker | null = null;
  #terminatedError: WorkerClientError | null = null;
  #generation = 0;

  constructor(maxProcessingMs = 30_000) {
    this.#maxProcessingMs = maxProcessingMs;
    this.#createWorker();
  }

  get workerGeneration(): number {
    return this.#generation;
  }

  trackObjectUrl(url: string): void {
    this.#objectUrls.add(url);
  }

  request<T>(
    operation: string,
    payload: unknown,
    transfer: Transferable[] = [],
    envelope: WorkerRequestEnvelope = {},
  ): Promise<T> {
    if (this.#worker === null) {
      if (operation !== 'openDocument') {
        return Promise.reject(this.#terminatedError ?? new WorkerClientError({
          code: 'RESOURCE_LIMIT',
          message: 'Worker was terminated; open a new document to continue',
        }));
      }
      this.#createWorker();
    }
    const worker = this.#worker!;
    const requestId = crypto.randomUUID();
    const timeoutMs = envelope.timeoutMs ?? this.#maxProcessingMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#destroy(new WorkerClientError({
          code: 'RESOURCE_LIMIT',
          message: `Worker request exceeded ${timeoutMs} ms`,
          details: { maxProcessingMs: timeoutMs },
        }));
      }, Math.max(0, timeoutMs));
      this.#pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        worker.postMessage({ requestId, operation, payload, ...envelope }, transfer);
      } catch (error) {
        this.#destroy(new WorkerClientError({
          code: 'INTERNAL_FAILURE',
          message: error instanceof Error ? error.message : 'Worker request could not be posted',
        }));
      }
    });
  }

  terminate(): void {
    this.#destroy(new WorkerClientError({
      code: 'RESOURCE_LIMIT',
      message: 'Worker session was terminated',
    }));
  }

  #createWorker(): void {
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.#worker = worker;
    this.#terminatedError = null;
    this.#generation += 1;
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (worker !== this.#worker) return;
      const pending = this.#pending.get(data.requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(data.requestId);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new WorkerClientError(data.error));
    };
    worker.onerror = ({ message }) => {
      if (worker !== this.#worker) return;
      this.#destroy(new WorkerClientError({
        code: 'INTERNAL_FAILURE',
        message: message || 'Worker execution failed',
      }));
    };
  }

  #destroy(error: WorkerClientError): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#terminatedError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }
}

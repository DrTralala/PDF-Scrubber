import type {
  EngineErrorCode,
  EngineErrorDescriptor,
} from '@pdf-editor/pdf-engine';
import type {
  EngineOperation,
  EngineResponse,
  RichReplacementPreconditions,
  ReplacementPreconditions,
} from '@pdf-editor/worker-protocol';

import { createEngineWorker } from './create-worker';

type PendingRequest = Readonly<{
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}>;

export type RequestEnvelope = Readonly<{
  documentId?: string;
  revision?: number;
  preconditions?:
    | ReplacementPreconditions
    | RichReplacementPreconditions
    | Readonly<{ validatedCandidateHash: string }>;
  timeoutMs?: number;
}>;

export interface EngineTransport {
  request<T>(
    operation: EngineOperation,
    payload: unknown,
    transfer: Transferable[],
    envelope: RequestEnvelope,
  ): Promise<T>;
  terminate(): void;
}

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

export class WorkerTransport implements EngineTransport {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #workerFactory: () => Worker;
  readonly #maxProcessingMs: number;
  #worker: Worker | null = null;
  #terminatedError: WorkerClientError | null = null;

  constructor(
    workerFactory: () => Worker = createEngineWorker,
    maxProcessingMs = 30_000,
  ) {
    this.#workerFactory = workerFactory;
    this.#maxProcessingMs = maxProcessingMs;
    this.#createWorker();
  }

  request<T>(
    operation: EngineOperation,
    payload: unknown,
    transfer: Transferable[] = [],
    envelope: RequestEnvelope = {},
  ): Promise<T> {
    if (this.#worker === null) {
      if (operation !== 'openDocument') {
        return Promise.reject(new WorkerClientError({
          code: 'INTERNAL_FAILURE',
          message: 'Worker was terminated; use openDocument to start a new session',
        }));
      }
      this.#createWorker();
    }

    const worker = this.#worker!;
    const requestId = crypto.randomUUID();
    const timeoutMs = envelope.timeoutMs ?? this.#maxProcessingMs;
    const { timeoutMs: _timeoutMs, ...requestEnvelope } = envelope;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#destroy(new WorkerClientError({
          code: 'RESOURCE_LIMIT',
          message: `Worker request exceeded ${timeoutMs} ms`,
          details: { resource: 'processingTime', limit: timeoutMs },
        }));
      }, Math.max(0, timeoutMs));

      this.#pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        worker.postMessage(
          { requestId, operation, payload, ...requestEnvelope },
          transfer,
        );
      } catch (error) {
        this.#destroy(new WorkerClientError({
          code: 'INTERNAL_FAILURE',
          message: error instanceof Error
            ? error.message
            : 'Worker request could not be posted',
        }));
      }
    });
  }

  terminate(): void {
    this.#destroy(new WorkerClientError({
      code: 'INTERNAL_FAILURE',
      message: 'Worker session was terminated',
    }));
  }

  #createWorker(): void {
    const worker = this.#workerFactory();
    this.#worker = worker;
    this.#terminatedError = null;

    worker.addEventListener('message', ({ data }: MessageEvent<EngineResponse>) => {
      if (worker !== this.#worker) return;
      const pending = this.#pending.get(data.requestId);
      if (pending === undefined) return;

      clearTimeout(pending.timer);
      this.#pending.delete(data.requestId);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new WorkerClientError(data.error));
    });

    worker.addEventListener('error', (event) => {
      if (worker !== this.#worker) return;
      this.#destroy(new WorkerClientError({
        code: 'INTERNAL_FAILURE',
        message: event.message || 'Worker execution failed',
      }));
    });
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
  }
}

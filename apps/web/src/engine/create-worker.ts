export function createEngineWorker(): Worker {
  const rejectValidation = import.meta.env.MODE === 'test'
    && sessionStorage.getItem('pdf-scrubber:reject-validation') === '1';
  return new Worker(new URL('./engine.worker.ts', import.meta.url), {
    type: 'module',
    name: rejectValidation
      ? 'pdf-scrubber-pdf-engine-test-reject-validation'
      : 'pdf-scrubber-pdf-engine',
  });
}

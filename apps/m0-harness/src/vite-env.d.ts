/// <reference types="vite/client" />

import type { EngineLimits, EngineResourceUsage } from '@pdf-editor/pdf-engine';

declare global {
  interface Window {
    __m0WorkerObserved?: boolean;
    __m0ShapingObserved?: boolean;
    __m0SessionObserved?: boolean;
    __m0ResourceProbe?: (
      bytes: ArrayBuffer,
      limits: EngineLimits,
      analyse: boolean,
      validate?: boolean,
    ) => Promise<EngineResourceUsage & Readonly<{ analysedSpans: number; durationMs: number }>>;
  }
}

export {};

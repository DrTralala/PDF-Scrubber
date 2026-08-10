export type EngineLimits = Readonly<{
  maxFileBytes: number;
  maxObjects: number;
  maxNestingDepth: number;
  maxDecodedStreamBytes: number;
  maxOperationsPerStream: number;
  maxImagePixels: number;
  maxProcessingMs: number;
}>;

export type EngineResourceUsage = Readonly<{
  fileBytes: number;
  objectCount: number;
  maximumNestingDepth: number;
  peakDecodedStreamBytes: number;
  totalDecodedStreamBytes: number;
}>;

export const MAX_PDF_FILE_MIB = 15;
export const MAX_PDF_FILE_BYTES = MAX_PDF_FILE_MIB * 1024 * 1024;

export const PROVISIONAL_LIMITS: EngineLimits = Object.freeze({
  maxFileBytes: MAX_PDF_FILE_BYTES,
  maxObjects: 2_000,
  maxNestingDepth: 12,
  maxDecodedStreamBytes: 4 * 1024 * 1024,
  maxOperationsPerStream: 50_000,
  maxImagePixels: 12_000_000,
  maxProcessingMs: 30_000,
});

export const MAX_FONT_FACE_BYTES = 64 * 1024 * 1024;
export const MAX_FONT_REGISTRY_BYTES = 128 * 1024 * 1024;
export const MAX_FONT_REGISTRY_FACES = 32;

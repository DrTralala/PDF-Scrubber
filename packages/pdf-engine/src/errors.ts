export const ENGINE_ERROR_CODES = [
  'UNSUPPORTED_DOCUMENT',
  'MALFORMED_INPUT',
  'RESOURCE_LIMIT',
  'READ_ONLY_SPAN',
  'FONT_UNAVAILABLE',
  'FONT_EMBEDDING_PROHIBITED',
  'REPLACEMENT_OVERFLOW',
  'STALE_REVISION',
  'VALIDATION_FAILURE',
  'INTERNAL_FAILURE',
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export const ENGINE_RESOURCE_LIMITS = [
  'fileBytes',
  'indirectObjects',
  'nestingDepth',
  'decodedStreamBytes',
  'operations',
  'imagePixels',
  'processingTime',
] as const;

export type EngineResourceLimit = (typeof ENGINE_RESOURCE_LIMITS)[number];

export type EngineErrorDescriptor = Readonly<{
  code: EngineErrorCode;
  message: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}>;

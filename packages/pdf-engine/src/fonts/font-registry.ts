import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';
import { fingerprint } from '../fingerprint';
import {
  MAX_FONT_FACE_BYTES,
  MAX_FONT_REGISTRY_BYTES,
  MAX_FONT_REGISTRY_FACES,
} from '../limits';
import { inspectFont, type FontInspection } from './font-inspection';
import { resolveFontRequirement } from './font-matching';

export type FontSourceKind = 'embedded' | 'local' | 'upload' | 'bundled';
export type FontMatchKind = 'exact' | 'compatible-version' | 'substitute';

export type FontRegistration = Readonly<{
  source: FontSourceKind;
  fileName: string | null;
  bytes: Uint8Array;
}>;

export type FontDescriptor = Readonly<{
  id: string;
  hash: string;
  source: FontSourceKind;
  fileName: string | null;
  byteLength: number;
  inspection: FontInspection;
}>;

export type FontRequirement = Readonly<{
  postscriptName: string | null;
  familyName: string | null;
  subfamilyName: string | null;
  weight: number;
  italic: boolean;
  requiredCodePoints: readonly number[];
  exactByteHash: string | null;
  metricsFingerprint: string | null;
}>;

export type FontResolution =
  | Readonly<{
      kind: FontMatchKind;
      font: FontDescriptor;
      reasons: readonly string[];
    }>
  | Readonly<{
      kind: 'unavailable';
      font: null;
      reasons: readonly string[];
    }>;

export type FontRegistryLimits = Readonly<{
  maxFaceBytes: number;
  maxFaces: number;
  maxTotalBytes: number;
}>;

class FontRegistryError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'FontRegistryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

type StoredFont = Readonly<{
  descriptor: FontDescriptor;
  bytes: Uint8Array<ArrayBuffer>;
}>;

const DEFAULT_LIMITS: FontRegistryLimits = Object.freeze({
  maxFaceBytes: MAX_FONT_FACE_BYTES,
  maxFaces: MAX_FONT_REGISTRY_FACES,
  maxTotalBytes: MAX_FONT_REGISTRY_BYTES,
});

function validateLimits(limits: FontRegistryLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}

export class FontRegistry {
  readonly #limits: FontRegistryLimits;
  readonly #fonts = new Map<string, StoredFont>();
  #totalBytes = 0;

  constructor(limits: FontRegistryLimits = DEFAULT_LIMITS) {
    validateLimits(limits);
    this.#limits = Object.freeze({ ...limits });
  }

  async register(input: FontRegistration): Promise<FontDescriptor> {
    if (input.bytes.byteLength === 0) {
      throw new FontRegistryError('FONT_UNAVAILABLE', 'Font bytes are empty');
    }
    if (input.bytes.byteLength > this.#limits.maxFaceBytes) {
      throw new FontRegistryError('RESOURCE_LIMIT', 'Font exceeds the per-face byte limit', {
        actual: input.bytes.byteLength,
        limit: this.#limits.maxFaceBytes,
      });
    }
    const hash = await fingerprint(input.bytes);
    const existing = this.#fonts.get(hash);
    if (existing !== undefined) return existing.descriptor;
    if (this.#fonts.size >= this.#limits.maxFaces) {
      throw new FontRegistryError('RESOURCE_LIMIT', 'Font catalogue face limit exceeded', {
        limit: this.#limits.maxFaces,
      });
    }
    if (input.bytes.byteLength > this.#limits.maxTotalBytes - this.#totalBytes) {
      throw new FontRegistryError('RESOURCE_LIMIT', 'Font catalogue byte limit exceeded', {
        actual: this.#totalBytes + input.bytes.byteLength,
        limit: this.#limits.maxTotalBytes,
      });
    }

    const inspection = await inspectFont(input.bytes);
    if (!inspection.embedding.documentEditingAllowed) {
      throw new FontRegistryError(
        'FONT_EMBEDDING_PROHIBITED',
        `Font embedding does not permit edited documents (${inspection.embedding.usage})`,
        { usage: inspection.embedding.usage, bitmapOnly: inspection.embedding.bitmapOnly },
      );
    }
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(input.bytes.byteLength);
    bytes.set(input.bytes);
    const descriptor: FontDescriptor = Object.freeze({
      id: `font:${hash}`,
      hash,
      source: input.source,
      fileName: input.fileName,
      byteLength: bytes.byteLength,
      inspection,
    });
    this.#fonts.set(hash, Object.freeze({ descriptor, bytes }));
    this.#totalBytes += bytes.byteLength;
    return descriptor;
  }

  list(): readonly FontDescriptor[] {
    return Object.freeze([...this.#fonts.values()].map(({ descriptor }) => descriptor));
  }

  getBytes(id: string): Uint8Array<ArrayBuffer> {
    const stored = [...this.#fonts.values()].find(({ descriptor }) => descriptor.id === id);
    if (stored === undefined) {
      throw new FontRegistryError('FONT_UNAVAILABLE', `Font ${id} is not registered`);
    }
    const copy: Uint8Array<ArrayBuffer> = new Uint8Array(stored.bytes.byteLength);
    copy.set(stored.bytes);
    return copy;
  }

  resolve(requirement: FontRequirement): FontResolution {
    return resolveFontRequirement(requirement, this.list());
  }

  clear(): void {
    for (const stored of this.#fonts.values()) stored.bytes.fill(0);
    this.#fonts.clear();
    this.#totalBytes = 0;
  }
}

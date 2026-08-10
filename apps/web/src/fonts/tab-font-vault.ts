import type {
  FontDescriptor,
  FontSourceKind,
} from '@pdf-editor/pdf-engine';

export type SessionFontSource = Extract<FontSourceKind, 'local' | 'upload'>;

export type FontRegistrationClient = Readonly<{
  registerFont(
    source: SessionFontSource,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<FontDescriptor>;
}>;

export type VaultFontInput = Readonly<{
  source: SessionFontSource;
  fileName: string;
  bytes: Uint8Array;
}>;

type StoredVaultFont = Readonly<{
  descriptor: FontDescriptor;
  bytes: Uint8Array<ArrayBuffer>;
}>;

export class TabFontVault {
  readonly #fonts = new Map<string, StoredVaultFont>();

  async register(
    input: VaultFontInput,
    client: FontRegistrationClient,
  ): Promise<FontDescriptor> {
    const owned = new Uint8Array(input.bytes.byteLength);
    owned.set(input.bytes);
    try {
      const descriptor = await client.registerFont(
        input.source,
        input.fileName,
        owned.slice(),
      );
      const existing = this.#fonts.get(descriptor.hash);
      if (existing !== undefined) {
        owned.fill(0);
        return existing.descriptor;
      }
      this.#fonts.set(descriptor.hash, Object.freeze({
        descriptor,
        bytes: owned,
      }));
      return descriptor;
    } catch (error) {
      owned.fill(0);
      throw error;
    }
  }

  async registerAllWith(client: FontRegistrationClient): Promise<void> {
    for (const stored of this.#fonts.values()) {
      const replayed = await client.registerFont(
        stored.descriptor.source as SessionFontSource,
        stored.descriptor.fileName ?? stored.descriptor.inspection.fullName ?? 'Local font',
        stored.bytes.slice(),
      );
      if (replayed.hash !== stored.descriptor.hash) {
        throw new Error('Re-registered font hash did not match the tab catalogue');
      }
    }
  }

  list(): readonly FontDescriptor[] {
    return Object.freeze(
      [...this.#fonts.values()].map(({ descriptor }) => descriptor),
    );
  }

  dispose(): void {
    for (const stored of this.#fonts.values()) stored.bytes.fill(0);
    this.#fonts.clear();
  }
}

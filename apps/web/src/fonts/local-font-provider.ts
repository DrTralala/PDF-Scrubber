type BrowserFontData = Readonly<{
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  blob(): Promise<Blob>;
}>;

export type LocalFontAccessHost = Readonly<{
  isSecureContext?: boolean;
  queryLocalFonts?: () => Promise<readonly BrowserFontData[]>;
}>;

export type LocalFontAvailability =
  | 'available'
  | 'insecure-context'
  | 'unsupported';

export type BrowserLocalFont = Readonly<{
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
}>;

export class BrowserLocalFontProvider {
  readonly #fontData = new WeakMap<BrowserLocalFont, BrowserFontData>();

  constructor(
    private readonly host: LocalFontAccessHost = globalThis as LocalFontAccessHost,
  ) {}

  availability(): LocalFontAvailability {
    if (this.host.isSecureContext === false) return 'insecure-context';
    return typeof this.host.queryLocalFonts === 'function'
      ? 'available'
      : 'unsupported';
  }

  isSupported(): boolean {
    return this.availability() === 'available';
  }

  async requestFonts(): Promise<readonly BrowserLocalFont[]> {
    if (this.availability() === 'insecure-context') {
      throw new Error('Local Font Access requires a secure context');
    }
    const queryLocalFonts = this.host.queryLocalFonts;
    if (queryLocalFonts === undefined) {
      throw new Error('Local Font Access is not supported by this browser');
    }
    const data = await queryLocalFonts.call(this.host);
    const fonts = data.map((entry) => {
      const font = Object.freeze({
        postscriptName: entry.postscriptName,
        fullName: entry.fullName,
        family: entry.family,
        style: entry.style,
      });
      this.#fontData.set(font, entry);
      return font;
    });
    return Object.freeze(fonts);
  }

  async readFont(font: BrowserLocalFont): Promise<Uint8Array<ArrayBuffer>> {
    const data = this.#fontData.get(font);
    if (data === undefined) {
      throw new TypeError('Local font did not originate from this provider');
    }
    const buffer = await (await data.blob()).arrayBuffer();
    return new Uint8Array(buffer.slice(0));
  }
}

export function localFontAccessErrorMessage(error: unknown): string {
  const name = error !== null && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : '';
  if (name === 'NotAllowedError') {
    return 'Local font permission was denied. Allow local fonts for this site in your browser settings, then try again.';
  }
  if (name === 'SecurityError') {
    return "Local fonts are blocked by this browser or organisation's Permissions Policy. Upload a font file instead.";
  }
  return 'Local fonts could not be read. Upload a font file instead.';
}

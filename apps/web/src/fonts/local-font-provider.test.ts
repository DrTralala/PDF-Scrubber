import { describe, expect, it, vi } from 'vitest';

import {
  BrowserLocalFontProvider,
  localFontAccessErrorMessage,
  type LocalFontAccessHost,
} from './local-font-provider';

function fontData(
  metadata: Readonly<{
    postscriptName: string;
    fullName: string;
    family: string;
    style: string;
  }>,
  bytes: Uint8Array,
) {
  return {
    ...metadata,
    blob: vi.fn(async () => new Blob([bytes.slice()])),
  };
}

describe('BrowserLocalFontProvider', () => {
  it('enumerates only on request and reads an owned copy of selected font bytes', async () => {
    const source = Uint8Array.of(1, 2, 3);
    const data = fontData({
      postscriptName: 'Example-Regular',
      fullName: 'Example Regular',
      family: 'Example',
      style: 'Regular',
    }, source);
    const queryLocalFonts = vi.fn(async () => [data]);
    const provider = new BrowserLocalFontProvider({ queryLocalFonts });

    expect(provider.isSupported()).toBe(true);
    expect(queryLocalFonts).not.toHaveBeenCalled();
    const [font] = await provider.requestFonts();
    expect(queryLocalFonts).toHaveBeenCalledOnce();
    expect(data.blob).not.toHaveBeenCalled();
    expect(font).toEqual({
      postscriptName: 'Example-Regular',
      fullName: 'Example Regular',
      family: 'Example',
      style: 'Regular',
    });

    const bytes = await provider.readFont(font!);
    source[0] = 9;
    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(data.blob).toHaveBeenCalledOnce();
  });

  it('reports unsupported hosts without invoking another capability', async () => {
    const provider = new BrowserLocalFontProvider({} as LocalFontAccessHost);

    expect(provider.isSupported()).toBe(false);
    await expect(provider.requestFonts()).rejects.toThrow(/not supported/i);
  });

  it('preserves permission denial from the browser', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError');
    const provider = new BrowserLocalFontProvider({
      queryLocalFonts: vi.fn(async () => Promise.reject(denied)),
    });

    await expect(provider.requestFonts()).rejects.toBe(denied);
  });

  it('classifies available, insecure, and unsupported browser environments', () => {
    expect(new BrowserLocalFontProvider({
      isSecureContext: true,
      queryLocalFonts: vi.fn(async () => []),
    } as LocalFontAccessHost).availability()).toBe('available');
    expect(new BrowserLocalFontProvider({
      isSecureContext: false,
    } as LocalFontAccessHost).availability()).toBe('insecure-context');
    expect(new BrowserLocalFontProvider({
      isSecureContext: true,
    } as LocalFontAccessHost).availability()).toBe('unsupported');
  });

  it('maps browser permission and policy failures to actionable messages', () => {
    expect(localFontAccessErrorMessage(
      new DOMException('Permission denied', 'NotAllowedError'),
    )).toBe(
      'Local font permission was denied. Allow local fonts for this site in your browser settings, then try again.',
    );
    expect(localFontAccessErrorMessage(
      new DOMException('Policy blocked', 'SecurityError'),
    )).toBe(
      "Local fonts are blocked by this browser or organisation's Permissions Policy. Upload a font file instead.",
    );
    expect(localFontAccessErrorMessage(new Error('private detail'))).toBe(
      'Local fonts could not be read. Upload a font file instead.',
    );
  });
});

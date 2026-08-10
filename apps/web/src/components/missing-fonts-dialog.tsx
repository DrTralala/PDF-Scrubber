import { useEffect, useRef, useState, type JSX } from 'react';

import type {
  DocumentEditingFont,
  DocumentEditingFontReason,
  FontDescriptor,
} from '@pdf-editor/pdf-engine';

import { fontRegistrationErrorMessage } from '../fonts/font-registration-error';
import type { FontInventoryState } from '../model/editor-state';

export type RegisterFont = (
  fileName: string,
  bytes: Uint8Array,
) => Promise<FontDescriptor>;

export function missingFontDownloadUrl(name: string): string {
  const url = new URL('https://fonts2u.com/search.html');
  url.search = new URLSearchParams({ q: name }).toString();
  return url.toString();
}

type RowTone = 'neutral' | 'success' | 'error';
type RowState = Readonly<{ busy: boolean; message: string; tone: RowTone }>;
const EMPTY_ROW: RowState = Object.freeze({ busy: false, message: '', tone: 'neutral' });
const EDITING_FONT_REASON_COPY: Readonly<Record<DocumentEditingFontReason, string>> = Object.freeze({
  'not-embedded': 'This font is not embedded in the PDF.',
  'embedded-not-reusable': 'Embedded for display, but PDF-Scrubber cannot reuse it for editing.',
  'standard-font': 'A separate font file is required to preserve this standard PDF font while editing.',
});

export function MissingFontsDialog({
  inventoryState,
  editingFonts,
  registerFont,
  onClose,
}: Readonly<{
  inventoryState: FontInventoryState;
  editingFonts: readonly DocumentEditingFont[];
  registerFont: RegisterFont;
  onClose(): void;
}>): JSX.Element {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<Readonly<Record<string, RowState>>>({});
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const setRow = (name: string, patch: Partial<RowState>): void => {
    setRows((current) => ({
      ...current,
      [name]: { ...(current[name] ?? EMPTY_ROW), ...patch },
    }));
  };

  const importFont = async (missingName: string, file: File): Promise<void> => {
    setRow(missingName, {
      busy: true,
      message: 'Registering and checking font…',
      tone: 'neutral',
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      setRow(missingName, {
        busy: false,
        message: 'The selected font file could not be read.',
        tone: 'error',
      });
      return;
    }
    try {
      const descriptor = await registerFont(file.name, bytes);
      const registeredName = descriptor.inspection.fullName
        ?? descriptor.inspection.postscriptName
        ?? descriptor.fileName
        ?? 'Font';
      setRow(missingName, {
        busy: false,
        message: `Imported ${registeredName} successfully`,
        tone: 'success',
      });
    } catch (error) {
      setRow(missingName, {
        busy: false,
        message: fontRegistrationErrorMessage(error),
        tone: 'error',
      });
    }
  };

  return (
    <dialog
      open
      className="missing-fonts-dialog"
      aria-labelledby="editing-fonts-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="editing-fonts-title">Fonts needed for editing</h2>
      {inventoryState === 'scanning' && <p>Inspecting fonts needed for editing…</p>}
      {inventoryState === 'failed' && (
        <p>We could not inspect this PDF’s font resources.</p>
      )}
      {inventoryState === 'ready' && editingFonts.length === 0 && (
        <p>No document fonts require a separate editing font.</p>
      )}
      {inventoryState === 'ready' && editingFonts.length > 0 && (
        <ul>
          {editingFonts.map((font) => {
            const row = rows[font.name] ?? EMPTY_ROW;
            return (
              <li className="missing-font-row" key={font.name}>
                <strong>{font.name}</strong>
                <div className="missing-font-actions">
                  <button
                    type="button"
                    aria-label={`Import ${font.name}`}
                    disabled={row.busy}
                    onClick={() => inputRefs.current.get(font.name)?.click()}
                  >Import</button>
                  <input
                    ref={(input) => {
                      if (input === null) inputRefs.current.delete(font.name);
                      else inputRefs.current.set(font.name, input);
                    }}
                    className="sr-only"
                    aria-label={`Choose font file for ${font.name}`}
                    type="file"
                    accept=".ttf,.otf,.woff,font/ttf,font/otf,font/woff"
                    disabled={row.busy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file !== undefined) void importFont(font.name, file);
                      event.currentTarget.value = '';
                    }}
                  />
                  <a
                    className="button-link"
                    aria-label={`Download ${font.name}`}
                    href={missingFontDownloadUrl(font.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >Download</a>
                </div>
                <p>{EDITING_FONT_REASON_COPY[font.reason]}</p>
                <p
                  className={row.tone === 'success'
                    ? 'font-import-success'
                    : row.tone === 'error' ? 'font-import-error' : undefined}
                  aria-live="polite"
                >
                  {row.message}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <button ref={closeButtonRef} type="button" onClick={onClose}>Close</button>
    </dialog>
  );
}

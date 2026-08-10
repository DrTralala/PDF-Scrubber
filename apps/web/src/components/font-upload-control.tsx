import { useMemo, useState, type JSX } from 'react';

import {
  BrowserLocalFontProvider,
  localFontAccessErrorMessage,
  type BrowserLocalFont,
} from '../fonts/local-font-provider';
import {
  matchLocalFont,
  type LocalFontRequirementResult,
} from '../fonts/local-font-matching';
import { fontRegistrationErrorMessage } from '../fonts/font-registration-error';
import type {
  FontApplicationResult,
  FontApplicationTarget,
} from '../session/editor-controller';

type ApplyFont = (
  source: 'local' | 'upload',
  fileName: string,
  bytes: Uint8Array,
  target: FontApplicationTarget,
) => Promise<FontApplicationResult>;

function fontName(result: FontApplicationResult): string {
  return result.descriptor.inspection.fullName
    ?? result.descriptor.inspection.postscriptName
    ?? result.descriptor.fileName
    ?? 'Font';
}

export function FontUploadControl({
  applyFont,
  target,
  requirement,
  provider,
}: Readonly<{
  applyFont: ApplyFont;
  target: FontApplicationTarget;
  requirement: LocalFontRequirementResult;
  provider?: BrowserLocalFontProvider;
}>): JSX.Element {
  const localProvider = useMemo(() => provider ?? new BrowserLocalFontProvider(), [provider]);
  const [localFonts, setLocalFonts] = useState<readonly BrowserLocalFont[]>([]);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const localAvailability = localProvider.availability();
  const matchingLocalFont = useMemo(
    () => matchLocalFont(requirement, localFonts),
    [requirement, localFonts],
  );

  const apply = async (
    source: 'local' | 'upload',
    fileName: string,
    bytes: Uint8Array,
  ): Promise<void> => {
    setBusy(true);
    setStatus('Registering and checking font…');
    try {
      const result = await applyFont(source, fileName, bytes, target);
      const name = fontName(result);
      setStatus(result.outcome === 'applied'
        ? `${name} applied. Reshaping text…`
        : result.outcome === 'stale-selection'
          ? `${name} was registered for this tab, but the selection changed, so it was not applied.`
          : `${name} was registered for this tab, but it does not cover all selected characters.`);
    } catch (error) {
      setStatus(fontRegistrationErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const useLocalFont = async (font: BrowserLocalFont): Promise<void> => {
    setBusy(true);
    setStatus('Reading authorised local font…');
    try {
      const bytes = await localProvider.readFont(font);
      await apply('local', `${font.postscriptName}.font`, bytes);
    } catch (error) {
      setStatus(localFontAccessErrorMessage(error));
      setBusy(false);
    }
  };

  return (
    <section className="font-source-controls" aria-labelledby="font-source-title">
      <h3 id="font-source-title">Use another font</h3>
      <label>
        Upload and apply font
        <input
          aria-label="Upload and apply font"
          type="file"
          accept=".ttf,.otf,.woff,font/ttf,font/otf,font/woff"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file !== undefined) {
              void file.arrayBuffer()
                .then((buffer) => apply('upload', file.name, new Uint8Array(buffer)))
                .catch(() => setStatus('The selected font file could not be read.'));
            }
            event.currentTarget.value = '';
          }}
        />
      </label>
      {localAvailability === 'available' ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void localProvider.requestFonts()
              .then((fonts) => {
                setLocalFonts(fonts);
                setSelected(fonts[0]?.postscriptName ?? '');
                const match = matchLocalFont(requirement, fonts);
                setStatus(match.kind === 'match'
                  ? `Matching local font found: ${match.font.fullName}.`
                  : match.reason === 'mixed-font-requirement'
                    ? `${fonts.length} local fonts authorised, but the selection uses mixed font requirements.`
                    : match.reason === 'empty-selection'
                      ? `${fonts.length} local fonts authorised, but there is no text to match.`
                      : `${fonts.length} local fonts authorised. No exact match was found.`);
              })
              .catch((error: unknown) => setStatus(localFontAccessErrorMessage(error)))}
          >Enable local fonts</button>
          {localFonts.length > 0 && (
            <div className="local-font-picker">
              {matchingLocalFont.kind === 'match' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void useLocalFont(matchingLocalFont.font)}
                >Use matching local font</button>
              )}
              <label>
                Local font
                <select
                  aria-label="Local font"
                  value={selected}
                  onChange={(event) => setSelected(event.currentTarget.value)}
                >
                  {localFonts.map((font) => (
                    <option key={font.postscriptName} value={font.postscriptName}>
                      {font.fullName} · {font.style}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const font = localFonts.find(({ postscriptName }) => postscriptName === selected);
                  if (font !== undefined) {
                    void useLocalFont(font);
                  }
                }}
              >Use selected local font</button>
            </div>
          )}
        </>
      ) : localAvailability === 'insecure-context' ? (
        <p>
          Local Font Access requires HTTPS or http://localhost:5173. If PDF-Scrubber is running in
          WSL, open the localhost URL instead of the WSL network address. Upload remains
          available.
        </p>
      ) : (
        <p>
          Local Font Access requires desktop Chrome or Edge. Upload a font file instead.
        </p>
      )}
      <p className="font-source-status" aria-live="polite">{status}</p>
    </section>
  );
}

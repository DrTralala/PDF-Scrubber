import type { JSX } from 'react';

import type { EditorRichFontStatus } from '../model/editor-state';

export function FontRequirementPanel({
  statuses,
  consents,
  onConsent,
}: Readonly<{
  statuses: readonly EditorRichFontStatus[];
  consents: readonly string[];
  onConsent(fontId: string, accepted: boolean): void;
}>): JSX.Element | null {
  const relevant = statuses.filter(({ matchKind }) => matchKind !== 'exact');
  if (relevant.length === 0) return null;
  return (
    <section className="font-requirements" aria-labelledby="font-requirements-title">
      <h3 id="font-requirements-title">Font substitution required</h3>
      {relevant.map((status) => (
        <div className="font-requirement" key={status.key}>
          <p>
            Requested: <strong>{status.requestedName ?? 'Unidentified font'}</strong><br />
            {status.matchKind === 'unavailable'
              ? 'No registered font covers this text. Upload a suitable font.'
              : <>Using: <strong>{status.actualName ?? 'Unnamed font'}</strong> ({status.source})</>}
          </p>
          {status.fontId !== null && status.matchKind !== 'unavailable' && (
            <label>
              <input
                type="checkbox"
                checked={consents.includes(status.fontId)}
                onChange={(event) => onConsent(status.fontId!, event.currentTarget.checked)}
              />
              Allow {status.actualName ?? 'selected font'} for {status.requestedName ?? 'unidentified font'}
            </label>
          )}
        </div>
      ))}
    </section>
  );
}

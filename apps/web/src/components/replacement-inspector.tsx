import type { HalfOpenRange } from '@pdf-editor/pdf-engine';
import { useEffect, useState, type JSX } from 'react';

import {
  CAPABILITY_REASON_COPY,
  type EditorSnapshot,
} from '../model/editor-state';
import type { EditorController } from '../session/editor-controller';
import { deriveLocalFontRequirement } from '../fonts/local-font-matching';
import { FitStatus, isLeftToRightHorizontalBaseline } from './fit-status';
import { FontRequirementPanel } from './font-requirement-panel';
import { FontUploadControl } from './font-upload-control';
import { FormatToolbar } from './format-toolbar';
import { RichTextEditor } from './rich-text-editor';

export function ReplacementInspector({
  controller,
  snapshot,
}: Readonly<{
  controller: EditorController;
  snapshot: EditorSnapshot;
}>): JSX.Element {
  const [replacement, setReplacement] = useState(snapshot.replacement);
  const [editorRange, setEditorRange] = useState<HalfOpenRange>({ start: 0, end: 0 });
  const selectedTextKey = snapshot.selection?.kind === 'text'
    ? snapshot.selection.textSelection.key
    : null;
  useEffect(() => setReplacement(snapshot.replacement), [snapshot.replacement]);
  useEffect(() => {
    if (snapshot.selection?.kind === 'text') {
      setEditorRange({ start: 0, end: snapshot.replacement.length });
    }
  }, [selectedTextKey]);

  const selection = snapshot.selection;
  if (selection === null) {
    return (
      <div className="inspector-empty">
        <p className="eyebrow">Text replacement</p>
        <h2>Select text on the page</h2>
        <p>Editable and read-only text is identified directly on the document.</p>
      </div>
    );
  }

  if (selection.kind === 'text') {
    const { textSelection } = selection;
    const richEditor = snapshot.richEditor;
    const explanation = textSelection.capability.reasons
      .map((reason) => CAPABILITY_REASON_COPY[reason])
      .filter((copy) => copy !== undefined);
    if (textSelection.capability.kind === 'readOnly') {
      return (
        <div className="inspector-read-only">
          <p className="eyebrow">Read-only text</p>
          <h2>{textSelection.text || 'Unmapped text'}</h2>
          {explanation.map((copy) => <p key={copy}>{copy}</p>)}
          <p>Choose another text group.</p>
        </div>
      );
    }
    if (richEditor === null) {
      return (
        <div className="replacement-inspector">
          <p className="eyebrow">Text selection</p>
          <h2>Preparing rich text…</h2>
        </div>
      );
    }
    const richText = richEditor.runs.map(({ text }) => text).join('');
    const localFontRequirement = deriveLocalFontRequirement(richEditor.runs, editorRange);
    const fontApplicationTarget = Object.freeze({
      generation: snapshot.generation,
      pageIndex: snapshot.pageIndex,
      selectionKey: textSelection.key,
      range: Object.freeze({ ...editorRange }),
    });
    const preview = richEditor.preview;
    const selectedLine = snapshot.analysis?.textLayout.lines.find(
      ({ key }) => key === textSelection.lineKey,
    );
    const fitLineEligible = selectedLine !== undefined &&
      isLeftToRightHorizontalBaseline(selectedLine.baselineDirection);
    const canApply = preview !== null
      && preview.fits
      && preview.requiredSubstitutionConsents.length === 0
      && preview.replacement === richText.normalize('NFC')
      && preview.selectionKey === textSelection.key
      && snapshot.phase !== 'applying';
    return (
      <div className="replacement-inspector">
        <p className="eyebrow">Rich text selection</p>
        <h2>Edit selected text</h2>
        <RichTextEditor
          runs={richEditor.runs}
          onReplace={(range, text) => controller.replaceRichText(range, text)}
          onSelectionChange={setEditorRange}
        />
        <FormatToolbar
          runs={richEditor.runs}
          selection={editorRange}
          fonts={snapshot.fonts}
          onFormat={(range, patch) => controller.formatRichText(range, patch)}
        />
        {textSelection.decorationWarnings.length > 0 && (
          <section
            className="decoration-warning"
            role="status"
            aria-label="Decoration warning"
          >
            <h3>Nearby line artwork preserved</h3>
            <p>
              Nearby line artwork could not be identified safely. It will be preserved and may not resize with edited text.
            </p>
          </section>
        )}
        <FontRequirementPanel
          statuses={richEditor.fontStatuses}
          consents={richEditor.substitutionConsents}
          onConsent={(fontId, accepted) =>
            controller.setRichSubstitutionConsent(fontId, accepted)}
        />
        <FontUploadControl
          applyFont={(source, fileName, bytes, target) =>
            controller.registerAndApplyFont(source, fileName, bytes, target)}
          target={fontApplicationTarget}
          requirement={localFontRequirement}
        />
        <FitStatus
          minimumWidth={textSelection.bounds.width}
          allowedRegion={richEditor.allowedRegion}
          maxAllowedWidth={richEditor.maxAllowedWidth}
          preview={preview}
          fitLineEligible={fitLineEligible}
          onWidth={(width) => controller.setRichAllowedWidth(width)}
        />
        <div className="preview-status" aria-live="polite">
          {snapshot.phase === 'applying'
            ? 'Applying and validating…'
            : snapshot.phase === 'previewing'
              ? 'Shaping text and checking fit…'
              : preview === null
                ? 'Waiting for shaped preview.'
                : !preview.fits
                  ? 'This text overflows the allowed region.'
                  : preview.requiredSubstitutionConsents.length > 0
                    ? 'Review and accept the font substitution.'
                    : 'Replacement is ready.'}
        </div>
        <button
          type="button"
          className="apply-replacement"
          disabled={!canApply}
          onClick={() => void controller.applySelection()}
        >Apply replacement</button>
      </div>
    );
  }

  const preview = snapshot.preview;
  const capability = preview?.capability ?? selection.span.capability;
  const explanation = capability.reasons
    .map((reason) => CAPABILITY_REASON_COPY[reason])
    .filter((copy) => copy !== undefined);

  if (selection.span.capability.kind === 'readOnly') {
    return (
      <div className="inspector-read-only">
        <p className="eyebrow">Read-only text</p>
        <h2>{selection.span.unicode ?? 'Unmapped text'}</h2>
        {explanation.map((copy) => <p key={copy}>{copy}</p>)}
        <p>Choose another text span.</p>
      </div>
    );
  }

  const normalised = replacement.normalize('NFC');
  const showConsent = capability.kind === 'replacementWithSubstitution';
  const previewMatches = preview !== null
    && preview.canApply
    && preview.normalisedReplacement === normalised
    && preview.preconditions.spanKey === selection.spanKey
    && preview.preconditions.expectedNormalisedReplacement === normalised
    && preview.preconditions.expectedSubstitutionAccepted
      === snapshot.acceptSubstitution
    && preview.substitutionAccepted === snapshot.acceptSubstitution;
  const canApply = previewMatches
    && normalised.length > 0
    && (!showConsent || snapshot.acceptSubstitution)
    && snapshot.phase !== 'applying';

  return (
    <div className="replacement-inspector">
      <p className="eyebrow">Text replacement</p>
      <h2>Edit selected text</h2>
      <label>
        Original
        <textarea value={selection.span.unicode ?? ''} readOnly rows={3} />
      </label>
      <label>
        Replace with
        <textarea
          aria-label="Replace with"
          value={replacement}
          rows={4}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setReplacement(value);
            controller.setReplacement(value);
          }}
        />
      </label>
      {showConsent && (
        <section className="substitution-notice" aria-labelledby="substitution-title">
          <h3 id="substitution-title">Font substitution required</h3>
          {explanation.map((copy) => <p key={copy}>{copy}</p>)}
          <label>
            <input
              type="checkbox"
              checked={snapshot.acceptSubstitution}
              onChange={(event) => controller.setAcceptSubstitution(
                event.currentTarget.checked,
              )}
            />
            Use substitute font
          </label>
        </section>
      )}
      {!showConsent && explanation.map((copy) => (
        <p className="capability-copy" key={copy}>{copy}</p>
      ))}
      <div className="preview-status" aria-live="polite">
        {snapshot.phase === 'applying'
          ? 'Applying and validating…'
          : snapshot.phase === 'previewing'
            ? 'Checking replacement…'
            : preview === null
              ? 'Enter replacement text to check it.'
              : preview.canApply
                ? 'Replacement is ready.'
                : 'This replacement cannot be applied yet.'}
      </div>
      <button
        type="button"
        className="apply-replacement"
        disabled={!canApply}
        onClick={() => void controller.applySelection()}
      >
        Apply replacement
      </button>
    </div>
  );
}

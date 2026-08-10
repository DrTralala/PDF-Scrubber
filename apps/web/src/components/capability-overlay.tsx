import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type {
  AnalysedTextGroup,
  AnalysedTextLine,
  Capability,
  CanonicalBounds,
  FontDescriptor,
  PdfColour,
} from '@pdf-editor/pdf-engine';
import { canonicalPageSize } from '@pdf-editor/pdf-engine';
import type { AnalysePageResult } from '@pdf-editor/worker-protocol';

import type {
  EditorRichState,
  EditorSelection,
  EditorTool,
} from '../model/editor-state';
import { toViewportRect, type ViewportRect } from '../pdf/viewport';
import type { EditorController } from '../session/editor-controller';

type Viewport = Readonly<{ width: number; height: number }>;
type Point = Readonly<{ x: number; y: number }>;
type DragOrigin = Readonly<{
  pointerId: number;
  lineKey: string;
  anchorGlyphIndex: number;
  focusGlyphIndex: number;
  moved: boolean;
}>;

function capabilityLabel(capability: Capability): string {
  switch (capability.kind) {
    case 'safeReplacement': return 'Editable';
    case 'replacementWithSubstitution': return 'Editable with font substitution';
    case 'readOnly': return 'Read-only';
  }
}

function capabilityMarker(capability: Capability): string {
  switch (capability.kind) {
    case 'safeReplacement': return 'Edit';
    case 'replacementWithSubstitution': return 'Font';
    case 'readOnly': return 'Read';
  }
}

function contains(rect: ViewportRect, point: Point): boolean {
  return point.x >= rect.left
    && point.x <= rect.left + rect.width
    && point.y >= rect.top
    && point.y <= rect.top + rect.height;
}

function unionBounds(bounds: readonly CanonicalBounds[]): CanonicalBounds | null {
  if (bounds.length === 0) return null;
  const minX = Math.min(...bounds.map((value) => value.x));
  const minY = Math.min(...bounds.map((value) => value.y));
  const maxX = Math.max(...bounds.map((value) => value.x + value.width));
  const maxY = Math.max(...bounds.map((value) => value.y + value.height));
  return Object.freeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

function eventPoint(event: PointerEvent<HTMLElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return Object.freeze({
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  });
}

function exactGlyphHit(
  lines: readonly AnalysedTextLine[],
  analysis: AnalysePageResult,
  viewport: Viewport,
  point: Point,
): Readonly<{ line: AnalysedTextLine; glyphIndex: number }> | null {
  for (const line of lines) {
    const glyphIndex = line.glyphs.findIndex((glyph) => contains(
      toViewportRect(glyph.bounds, analysis.pageSpace, viewport),
      point,
    ));
    if (glyphIndex >= 0) return Object.freeze({ line, glyphIndex });
  }
  return null;
}

function nearestGlyphOnLine(
  line: AnalysedTextLine,
  analysis: AnalysePageResult,
  viewport: Viewport,
  point: Point,
): number | null {
  const lineRect = toViewportRect(line.bounds, analysis.pageSpace, viewport);
  if (point.y < lineRect.top - 4 || point.y > lineRect.top + lineRect.height + 4) {
    return null;
  }
  let nearest: Readonly<{ index: number; distance: number }> | null = null;
  for (const [index, glyph] of line.glyphs.entries()) {
    const rect = toViewportRect(glyph.bounds, analysis.pageSpace, viewport);
    const centre = rect.left + rect.width / 2;
    const distance = Math.abs(point.x - centre);
    if (nearest === null || distance < nearest.distance) nearest = { index, distance };
  }
  return nearest?.index ?? null;
}

function groupContaining(
  line: AnalysedTextLine,
  glyphIndex: number,
): AnalysedTextGroup | null {
  return line.groups.find((group) => (
    glyphIndex >= group.glyphRange.start && glyphIndex < group.glyphRange.end
  )) ?? null;
}

function cssColour(colour: PdfColour): string {
  if (colour.colourSpace === 'DeviceRGB') {
    return `rgb(${colour.components.map((component) => Math.round(component * 255)).join(' ')})`;
  }
  if (colour.colourSpace === 'DeviceGray') {
    const value = Math.round(colour.components[0]! * 255);
    return `rgb(${value} ${value} ${value})`;
  }
  return 'var(--ink)';
}

export function CapabilityOverlay({
  controller,
  analysis,
  selection,
  richEditor = null,
  fonts = [],
  viewport,
  showOverlays,
  tool,
}: Readonly<{
  controller: EditorController;
  analysis: AnalysePageResult;
  selection: EditorSelection | null;
  richEditor?: EditorRichState | null;
  fonts?: readonly FontDescriptor[];
  viewport: Viewport;
  showOverlays: boolean;
  tool: EditorTool;
}>): JSX.Element {
  const groups = analysis.textLayout.groups;
  const selectedIndex = selection?.kind === 'text' && selection.groupKey !== null
    ? groups.findIndex((group) => group.key === selection.groupKey)
    : -1;
  const [activeIndex, setActiveIndex] = useState(selectedIndex >= 0 ? selectedIndex : 0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dragOrigin = useRef<DragOrigin | null>(null);

  useEffect(() => {
    if (selectedIndex >= 0) setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  const moveFocus = (index: number): void => {
    if (groups.length === 0) return;
    const next = (index + groups.length) % groups.length;
    setActiveIndex(next);
    buttonRefs.current[next]?.focus();
  };

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(groups.length - 1);
        break;
    }
  };

  const startSelection = (event: PointerEvent<HTMLDivElement>): void => {
    if (tool !== 'select' || event.button !== 0) return;
    const hit = exactGlyphHit(
      analysis.textLayout.lines,
      analysis,
      viewport,
      eventPoint(event),
    );
    if (hit === null) return;
    dragOrigin.current = Object.freeze({
      pointerId: event.pointerId,
      lineKey: hit.line.key,
      anchorGlyphIndex: hit.glyphIndex,
      focusGlyphIndex: hit.glyphIndex,
      moved: false,
    });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const moveSelection = (event: PointerEvent<HTMLDivElement>): void => {
    const origin = dragOrigin.current;
    if (origin === null || origin.pointerId !== event.pointerId) return;
    const line = analysis.textLayout.lines.find((candidate) => candidate.key === origin.lineKey);
    if (line === undefined) return;
    const focus = nearestGlyphOnLine(line, analysis, viewport, eventPoint(event));
    if (focus === null || focus === origin.focusGlyphIndex) return;
    dragOrigin.current = Object.freeze({ ...origin, focusGlyphIndex: focus, moved: true });
    controller.selectTextRange(line.key, origin.anchorGlyphIndex, focus, null);
  };

  const stopSelection = (event: PointerEvent<HTMLDivElement>): void => {
    const origin = dragOrigin.current;
    if (origin === null || origin.pointerId !== event.pointerId) return;
    dragOrigin.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const line = analysis.textLayout.lines.find((candidate) => candidate.key === origin.lineKey);
    if (line === undefined) return;
    if (origin.moved) {
      controller.selectTextRange(
        line.key,
        origin.anchorGlyphIndex,
        origin.focusGlyphIndex,
        null,
      );
      return;
    }
    const group = groupContaining(line, origin.anchorGlyphIndex);
    controller.selectTextRange(
      line.key,
      group?.glyphRange.start ?? origin.anchorGlyphIndex,
      group === undefined || group === null
        ? origin.anchorGlyphIndex
        : group.glyphRange.end - 1,
      group?.key ?? null,
    );
  };

  const cancelSelection = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragOrigin.current?.pointerId !== event.pointerId) return;
    dragOrigin.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const selectionBounds = selection?.kind === 'text'
    ? (() => {
        const line = analysis.textLayout.lines.find(
          (candidate) => candidate.key === selection.textSelection.lineKey,
        );
        if (line === undefined) return null;
        const glyphs = line.glyphs.slice(
          selection.textSelection.glyphRange.start,
          selection.textSelection.glyphRange.end,
        );
        return unionBounds(glyphs.map((glyph) => glyph.bounds));
      })()
    : null;
  const preview = richEditor?.preview ?? null;
  const [canonicalWidth] = canonicalPageSize(analysis.pageSpace);
  const previewScale = viewport.width / canonicalWidth;

  return (
    <div className="capability-overlay" data-show-overlays={showOverlays || undefined}>
      {groups.map((group, index) => {
        const line = analysis.textLayout.lines.find((candidate) => candidate.key === group.lineKey);
        if (line === undefined) return null;
        return (
          <button
            key={group.key}
            ref={(element) => { buttonRefs.current[index] = element; }}
            type="button"
            className={`text-group-overlay capability-${group.capability.kind}`}
            aria-label={`${group.text || 'Unmapped text'} — ${capabilityLabel(group.capability)}`}
            aria-pressed={selection?.kind === 'text' && selection.groupKey === group.key}
            tabIndex={index === activeIndex ? 0 : -1}
            style={toViewportRect(group.bounds, analysis.pageSpace, viewport)}
            onFocus={() => setActiveIndex(index)}
            onKeyDown={(event) => handleKey(event, index)}
            onClick={() => controller.selectTextRange(
              line.key,
              group.glyphRange.start,
              group.glyphRange.end - 1,
              group.key,
            )}
          >
            <span className="overlay-state" aria-hidden="true">
              {capabilityMarker(group.capability)}
            </span>
          </button>
        );
      })}
      {selectionBounds !== null && (
        <div
          className="text-selection-highlight"
          aria-hidden="true"
          style={toViewportRect(selectionBounds, analysis.pageSpace, viewport)}
        />
      )}
      {richEditor !== null && (
        <div
          className="rich-allowed-region"
          aria-hidden="true"
          style={toViewportRect(richEditor.allowedRegion, analysis.pageSpace, viewport)}
        />
      )}
      {preview !== null && (
        <>
          <div
            className={`rich-preview-bounds${preview.fits ? '' : ' rich-preview-overflow'}`}
            aria-hidden="true"
            style={toViewportRect(preview.replacementBounds, analysis.pageSpace, viewport)}
          />
          <div
            className="rich-preview-text"
            aria-hidden="true"
            style={toViewportRect(preview.replacementBounds, analysis.pageSpace, viewport)}
          >
            {richEditor!.runs.map((run, index) => {
              const descriptor = fonts.find(({ id }) => id === run.fontId);
              return (
                <span
                  key={`${run.fontId}:${index}`}
                  style={{
                    color: cssColour(run.style.fillColour),
                    fontFamily: descriptor?.inspection.familyName ?? run.style.fontBaseName ?? 'sans-serif',
                    fontSize: `${run.style.fontSize * previewScale}px`,
                    fontStyle: (run.style.italicAngle ?? 0) === 0 ? 'normal' : 'italic',
                    fontWeight: run.style.fontWeight ?? 400,
                    letterSpacing: `${run.style.characterSpacing * previewScale}px`,
                    wordSpacing: `${run.style.wordSpacing * previewScale}px`,
                  }}
                >{run.text}</span>
              );
            })}
          </div>
        </>
      )}
      <div
        className="text-selection-hit-layer"
        aria-hidden="true"
        onPointerDown={startSelection}
        onPointerMove={moveSelection}
        onPointerUp={stopSelection}
        onPointerCancel={cancelSelection}
      />
    </div>
  );
}

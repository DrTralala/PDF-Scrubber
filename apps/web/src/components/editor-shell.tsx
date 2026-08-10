import { useRef, useState, type JSX, type PointerEvent } from 'react';

import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController } from '../session/editor-controller';
import { EditorChrome } from './editor-chrome';
import { PdfPageView } from './pdf-page-view';
import { ReplacementInspector } from './replacement-inspector';
import { ToolRail } from './tool-rail';

type PanOrigin = Readonly<{
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
}>;

export function EditorShell({
  controller,
  snapshot,
}: Readonly<{
  controller: EditorController;
  snapshot: EditorSnapshot;
}>): JSX.Element {
  const canvasRef = useRef<HTMLElement>(null);
  const panOrigin = useRef<PanOrigin | null>(null);
  const [panning, setPanning] = useState(false);

  const startPan = (event: PointerEvent<HTMLElement>): void => {
    if (snapshot.tool !== 'pan' || event.button !== 0) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    panOrigin.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: canvas.scrollLeft,
      scrollTop: canvas.scrollTop,
    };
    canvas.setPointerCapture?.(event.pointerId);
    setPanning(true);
  };

  const movePan = (event: PointerEvent<HTMLElement>): void => {
    const origin = panOrigin.current;
    const canvas = canvasRef.current;
    if (origin === null || canvas === null || origin.pointerId !== event.pointerId) return;
    canvas.scrollLeft = origin.scrollLeft - (event.clientX - origin.clientX);
    canvas.scrollTop = origin.scrollTop - (event.clientY - origin.clientY);
  };

  const stopPan = (event: PointerEvent<HTMLElement>): void => {
    if (panOrigin.current?.pointerId !== event.pointerId) return;
    panOrigin.current = null;
    setPanning(false);
  };

  return (
    <div
      className="editor"
      data-phase={snapshot.phase}
      data-tool={snapshot.tool}
      data-panning={panning || undefined}
    >
      <EditorChrome controller={controller} snapshot={snapshot} />
      <ToolRail controller={controller} snapshot={snapshot} />
      <main
        ref={canvasRef}
        className="document-canvas"
        aria-label="PDF page"
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
      >
        <PdfPageView controller={controller} snapshot={snapshot} />
      </main>
      <aside className="inspector" aria-label="Text replacement inspector">
        <ReplacementInspector controller={controller} snapshot={snapshot} />
      </aside>
      <output className="sr-status" aria-live="polite">
        {snapshot.status}
      </output>
    </div>
  );
}

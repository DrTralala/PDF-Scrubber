import { Fragment, useRef, type JSX, type KeyboardEvent, type PointerEvent } from 'react';

import {
  canonicalPageSize,
  type CanonicalBounds,
} from '@pdf-editor/pdf-engine';
import type { AnalysePageResult } from '@pdf-editor/worker-protocol';

import type { EditorImagePlacement, EditorTool } from '../model/editor-state';
import { toViewportRect } from '../pdf/viewport';
import type { EditorController } from '../session/editor-controller';

type Viewport = Readonly<{ width: number; height: number }>;
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type Point = Readonly<{ x: number; y: number }>;
type Gesture = Readonly<{
  pointerId: number;
  imageId: string;
  bounds: CanonicalBounds;
  corner: Corner | null;
  start: Point;
}>;

const CORNERS: readonly Corner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

function toCanonicalPoint(
  event: PointerEvent<HTMLDivElement>,
  root: HTMLElement,
  analysis: AnalysePageResult,
  viewport: Viewport,
): Point {
  const rect = root.getBoundingClientRect();
  const [canonicalWidth, canonicalHeight] = canonicalPageSize(analysis.pageSpace);
  const scale = viewport.width / canonicalWidth;
  return Object.freeze({
    x: (event.clientX - rect.left) / scale,
    y: canonicalHeight - (event.clientY - rect.top) / scale,
  });
}

function resizeBounds(
  bounds: CanonicalBounds,
  corner: Corner,
  point: Point,
): CanonicalBounds {
  const fixedX = corner.endsWith('right') ? bounds.x : bounds.x + bounds.width;
  const fixedY = corner.startsWith('top') ? bounds.y : bounds.y + bounds.height;
  const aspect = bounds.width / bounds.height;
  const widthFromX = Math.abs(point.x - fixedX);
  const widthFromY = Math.abs(point.y - fixedY) * aspect;
  const width = Math.max(1, Math.abs(widthFromX - bounds.width) >= Math.abs(widthFromY - bounds.width)
    ? widthFromX
    : widthFromY);
  const height = width / aspect;
  return Object.freeze({
    x: corner.endsWith('right') ? fixedX : fixedX - width,
    y: corner.startsWith('top') ? fixedY : fixedY - height,
    width,
    height,
  });
}

function cornerPoint(bounds: CanonicalBounds, corner: Corner): Point {
  return Object.freeze({
    x: corner.endsWith('right') ? bounds.x + bounds.width : bounds.x,
    y: corner.startsWith('top') ? bounds.y + bounds.height : bounds.y,
  });
}

function visibleHandlePosition(
  image: EditorImagePlacement,
  corner: Corner,
  analysis: AnalysePageResult,
  viewport: Viewport,
): Point {
  const rect = toViewportRect(image.bounds, analysis.pageSpace, viewport);
  const cornerX = corner.endsWith('right') ? rect.left + rect.width : rect.left;
  const cornerY = corner.startsWith('bottom') ? rect.top + rect.height : rect.top;
  return Object.freeze({
    x: Math.max(0, Math.min(Math.max(0, viewport.width - 10), cornerX - 5)),
    y: Math.max(0, Math.min(Math.max(0, viewport.height - 10), cornerY - 5)),
  });
}

function keyDelta(key: string): Point | null {
  switch (key) {
    case 'ArrowLeft': return Object.freeze({ x: -1, y: 0 });
    case 'ArrowRight': return Object.freeze({ x: 1, y: 0 });
    case 'ArrowUp': return Object.freeze({ x: 0, y: 1 });
    case 'ArrowDown': return Object.freeze({ x: 0, y: -1 });
    default: return null;
  }
}

export function ImageOverlay({
  controller,
  analysis,
  images,
  selectedImageId,
  viewport,
  tool,
}: Readonly<{
  controller: EditorController;
  analysis: AnalysePageResult;
  images: readonly EditorImagePlacement[];
  selectedImageId: string | null;
  viewport: Viewport;
  tool: EditorTool;
}>): JSX.Element {
  const gesture = useRef<Gesture | null>(null);
  const pageImages = images.filter(({ pageIndex }) => pageIndex === analysis.pageIndex);

  const startGesture = (event: PointerEvent<HTMLDivElement>): void => {
    if (tool !== 'select' || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const wrapper = target.closest<HTMLElement>('[data-image-id]');
    const imageId = wrapper?.dataset.imageId;
    const placement = pageImages.find(({ id }) => id === imageId);
    if (imageId === undefined || placement === undefined) return;
    const handle = target.closest<HTMLElement>('[data-resize-corner]');
    const corner = handle?.dataset.resizeCorner as Corner | undefined;
    gesture.current = Object.freeze({
      pointerId: event.pointerId,
      imageId,
      bounds: placement.bounds,
      corner: corner ?? null,
      start: toCanonicalPoint(event, event.currentTarget, analysis, viewport),
    });
    controller.selectImage(imageId);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const moveGesture = (event: PointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    const point = toCanonicalPoint(event, event.currentTarget, analysis, viewport);
    if (active.corner === null) {
      controller.moveImage(active.imageId, Object.freeze({
        x: active.bounds.x + point.x - active.start.x,
        y: active.bounds.y + point.y - active.start.y,
        width: active.bounds.width,
        height: active.bounds.height,
      }));
      return;
    }
    const activeCorner = cornerPoint(active.bounds, active.corner);
    controller.setImageBounds(active.imageId, resizeBounds(active.bounds, active.corner, {
      x: activeCorner.x + point.x - active.start.x,
      y: activeCorner.y + point.y - active.start.y,
    }));
  };

  const stopGesture = (event: PointerEvent<HTMLDivElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const moveWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    image: EditorImagePlacement,
  ): void => {
    if (selectedImageId !== image.id) return;
    const delta = keyDelta(event.key);
    if (delta === null) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    controller.moveImage(image.id, Object.freeze({
      x: image.bounds.x + delta.x * step,
      y: image.bounds.y + delta.y * step,
      width: image.bounds.width,
      height: image.bounds.height,
    }));
  };

  const resizeWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    image: EditorImagePlacement,
    corner: Corner,
  ): void => {
    const delta = keyDelta(event.key);
    if (delta === null) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const activeCorner = cornerPoint(image.bounds, corner);
    controller.setImageBounds(image.id, resizeBounds(image.bounds, corner, {
      x: activeCorner.x + delta.x * step,
      y: activeCorner.y + delta.y * step,
    }));
  };

  return (
    <div
      className="image-overlay"
      onPointerDown={startGesture}
      onPointerMove={moveGesture}
      onPointerUp={stopGesture}
      onPointerCancel={stopGesture}
    >
      {pageImages.map((image, index) => {
        const selected = selectedImageId === image.id;
        return (
          <Fragment key={image.id}>
            <div
              className="image-placement"
              data-image-id={image.id}
              data-selected={selected || undefined}
              style={toViewportRect(image.bounds, analysis.pageSpace, viewport)}
            >
              <button
                type="button"
                className="image-body"
                aria-label={`Select inserted image ${index + 1}`}
                aria-pressed={selected}
                onClick={(event) => {
                  if (event.detail === 0) controller.selectImage(image.id);
                }}
                onKeyDown={(event) => moveWithKeyboard(event, image)}
              >
                <img src={image.previewUrl} alt="" draggable={false} />
              </button>
            </div>
            {selected && CORNERS.map((corner) => {
              const position = visibleHandlePosition(image, corner, analysis, viewport);
              return (
                <button
                  key={`${image.id}-${corner}`}
                  type="button"
                  className={`image-resize-handle image-resize-${corner}`}
                  aria-label={`Resize image at ${corner}`}
                  data-image-id={image.id}
                  data-resize-corner={corner}
                  style={{ left: `${position.x}px`, top: `${position.y}px` }}
                  onKeyDown={(event) => resizeWithKeyboard(event, image, corner)}
                />
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

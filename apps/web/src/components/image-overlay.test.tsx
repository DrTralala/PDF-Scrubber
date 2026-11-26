import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { analysisFixture, readyController } from '../test/fakes';
import type { EditorImagePlacement, EditorSnapshot } from '../model/editor-state';
import { PdfPageView } from './pdf-page-view';

vi.mock('../pdf/display-document', () => ({
  renderPageToCanvas: vi.fn(async (_page: unknown, _canvas: HTMLCanvasElement, zoom: number) => ({
    width: 612 * zoom,
    height: 792 * zoom,
  })),
}));

const image: EditorImagePlacement = Object.freeze({
  id: 'image-1',
  pageIndex: 0,
  bounds: Object.freeze({ x: 100, y: 100, width: 160, height: 80 }),
  format: 'png' as const,
  previewUrl: 'blob:preview-image',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPage(zoom: number, placement = image) {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  });
  const controller = readyController({
    analysis: analysisFixture(),
    zoom,
    fitMode: 'custom',
    images: [placement],
    selectedImageId: placement.id,
  });
  Object.assign(controller, {
    getDisplayPage: vi.fn(async () => ({
      getViewport: ({ scale = 1 }: { scale?: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
      }),
    })),
    selectImage: vi.fn(),
    moveImage: vi.fn(),
    setImageBounds: vi.fn(),
    clearSelection: vi.fn(),
  });
  const snapshot = controller.getSnapshot() as EditorSnapshot;
  const rendered = render(<PdfPageView controller={controller} snapshot={snapshot} />);
  await waitFor(() => expect(rendered.container.querySelector('.image-placement')).not.toBeNull());
  const overlay = rendered.container.querySelector<HTMLElement>('.image-overlay')!;
  Object.defineProperty(overlay, 'getBoundingClientRect', {
    value: () => ({
      left: 20,
      top: 30,
      right: 20 + 612 * zoom,
      bottom: 30 + 792 * zoom,
      width: 612 * zoom,
      height: 792 * zoom,
    }),
  });
  return { ...rendered, controller, overlay };
}

it.each([
  [1, '100px', '612px', '160px', '80px'],
  [0.5, '50px', '306px', '80px', '40px'],
])('shows the same canonical image placement at zoom %s', async (zoom, left, top, width, height) => {
  const { container } = await renderPage(zoom);
  const placement = container.querySelector<HTMLElement>('.image-placement')!;

  expect(placement.style.left).toBe(left);
  expect(placement.style.top).toBe(top);
  expect(placement.style.width).toBe(width);
  expect(placement.style.height).toBe(height);
});

it('keeps resize controls visible and usable when an intrinsic image covers every page corner', async () => {
  const oversized = Object.freeze({
    ...image,
    bounds: Object.freeze({ x: -694, y: -604, width: 2_000, height: 2_000 }),
  });
  const { controller, overlay } = await renderPage(1, oversized);
  const handles = screen.getAllByRole('button', { name: /^Resize image at / });

  expect(handles).toHaveLength(4);
  for (const handle of handles) {
    expect(Number.parseFloat(handle.style.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(handle.style.left)).toBeLessThan(612);
    expect(Number.parseFloat(handle.style.top)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(handle.style.top)).toBeLessThan(792);
  }
  expect(overlay.parentElement?.querySelector('.image-placement')?.getAttribute('style'))
    .toContain('width: 2000px');

  const handle = screen.getByRole('button', { name: 'Resize image at top-left' });
  const startX = 20 + Number.parseFloat(handle.style.left) + 5;
  const startY = 30 + Number.parseFloat(handle.style.top) + 5;
  fireEvent.pointerDown(handle, {
    button: 0,
    pointerId: 25,
    clientX: startX,
    clientY: startY,
  });
  fireEvent.pointerMove(overlay, {
    pointerId: 25,
    clientX: startX + 20,
    clientY: startY + 20,
  });
  fireEvent.pointerUp(overlay, {
    pointerId: 25,
    clientX: startX + 20,
    clientY: startY + 20,
  });

  expect(controller.setImageBounds).toHaveBeenLastCalledWith(
    oversized.id,
    expect.objectContaining({ width: expect.any(Number) }),
  );
  const resized = vi.mocked(controller.setImageBounds).mock.lastCall?.[1];
  expect(resized?.width).toBeLessThan(2_000);
  expect(resized?.width).toBeGreaterThan(0);
});

it('moves an image body in page coordinates without scaling it', async () => {
  const { controller, overlay } = await renderPage(1);
  const body = screen.getByRole('button', { name: 'Select inserted image 1' });

  fireEvent.pointerDown(body, {
    button: 0,
    pointerId: 21,
    clientX: 200,
    clientY: 682,
  });
  fireEvent.pointerMove(overlay, {
    pointerId: 21,
    clientX: 220,
    clientY: 692,
  });
  fireEvent.pointerUp(overlay, {
    button: 0,
    pointerId: 21,
    clientX: 220,
    clientY: 692,
  });

  expect(controller.selectImage).toHaveBeenCalledWith(image.id);
  expect(controller.moveImage).toHaveBeenLastCalledWith(image.id, {
    x: 120,
    y: 90,
    width: 160,
    height: 80,
  });
});

it.each([
  ['top-left', 120, 642, 90, 627, { x: 70, y: 100, width: 190, height: 95 }],
  ['top-right', 280, 642, 310, 627, { x: 100, y: 100, width: 190, height: 95 }],
  ['bottom-left', 120, 722, 90, 737, { x: 70, y: 85, width: 190, height: 95 }],
  ['bottom-right', 280, 722, 310, 737, { x: 100, y: 85, width: 190, height: 95 }],
] as const)('resizes proportionally from the %s corner', async (
  corner,
  clientX,
  clientY,
  nextX,
  nextY,
  expectedBounds,
) => {
  const { controller, overlay } = await renderPage(1);
  const handle = screen.getByRole('button', { name: `Resize image at ${corner}` });

  fireEvent.pointerDown(handle, {
    button: 0,
    pointerId: 22,
    clientX,
    clientY,
  });
  fireEvent.pointerMove(overlay, {
    pointerId: 22,
    clientX: nextX,
    clientY: nextY,
  });
  fireEvent.pointerUp(overlay, {
    button: 0,
    pointerId: 22,
    clientX: nextX,
    clientY: nextY,
  });

  expect(controller.setImageBounds).toHaveBeenLastCalledWith(image.id, expectedBounds);
});

it('clears image handles on a blank click and allows the image to be selected again', async () => {
  const { container, controller } = await renderPage(1);
  const hitLayer = container.querySelector<HTMLElement>('.text-selection-hit-layer')!;
  fireEvent.pointerDown(hitLayer, {
    button: 0,
    pointerId: 23,
    clientX: 400,
    clientY: 400,
  });
  fireEvent.pointerUp(hitLayer, {
    button: 0,
    pointerId: 23,
    clientX: 400,
    clientY: 400,
  });

  expect(controller.clearSelection).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select inserted image 1' }), {
    button: 0,
    pointerId: 24,
    clientX: 200,
    clientY: 682,
  });
  expect(controller.selectImage).toHaveBeenCalledWith(image.id);
});

it('moves images and resizes proportionally from the keyboard', async () => {
  const { controller } = await renderPage(1);
  const body = screen.getByRole('button', { name: 'Select inserted image 1' });
  fireEvent.keyDown(body, { key: 'ArrowRight', shiftKey: true });

  expect(controller.moveImage).toHaveBeenLastCalledWith(image.id, {
    x: 110,
    y: 100,
    width: 160,
    height: 80,
  });

  fireEvent.keyDown(screen.getByRole('button', { name: 'Resize image at top-left' }), {
    key: 'ArrowRight',
  });

  expect(controller.setImageBounds).toHaveBeenLastCalledWith(image.id, {
    x: 101,
    y: 100,
    width: 159,
    height: 79.5,
  });
});

it('does not consume an image request until its analysis page matches the request page', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  });
  const baseAnalysis = analysisFixture();
  const controller = readyController({
    analysis: baseAnalysis,
    pageIndex: 1,
    pageCount: 2,
  });
  const insertImage = vi.fn().mockResolvedValue(undefined);
  const handled = vi.fn();
  Object.assign(controller, {
    getDisplayPage: vi.fn(async () => ({
      getViewport: ({ scale = 1 }: { scale?: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
      }),
    })),
    insertImage,
  });
  const snapshot = controller.getSnapshot() as EditorSnapshot;
  const request = {
    id: 1,
    file: new File([Uint8Array.of(1)], 'stamp.png', { type: 'image/png' }),
    generation: snapshot.generation,
    pageIndex: 1,
  };
  const rendered = render(
    <main className="document-canvas">
      <PdfPageView
        controller={controller}
        snapshot={snapshot}
        imageRequest={request}
        onImageRequestHandled={handled}
      />
    </main>,
  );
  const documentCanvas = rendered.container.querySelector<HTMLElement>('.document-canvas')!;
  const pageFrame = rendered.container.querySelector<HTMLElement>('.page-frame')!;
  Object.defineProperties(documentCanvas, {
    clientLeft: { configurable: true, value: 0 },
    clientTop: { configurable: true, value: 0 },
    clientWidth: { configurable: true, value: 612 },
    clientHeight: { configurable: true, value: 792 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ left: 20, top: 30, right: 632, bottom: 822, width: 612, height: 792 }),
    },
  });
  Object.defineProperty(pageFrame, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 20, top: 30, right: 632, bottom: 822, width: 612, height: 792 }),
  });

  await waitFor(() => expect(
    rendered.container.querySelector<HTMLElement>('.page-frame')?.style.width,
  ).toBe('612px'));
  expect(insertImage).not.toHaveBeenCalled();
  expect(handled).not.toHaveBeenCalled();

  const matchingAnalysis = Object.freeze({
    ...baseAnalysis,
    pageIndex: 1,
    textLayout: Object.freeze({ ...baseAnalysis.textLayout, pageIndex: 1 }),
  });
  rendered.rerender(
    <main className="document-canvas">
      <PdfPageView
        controller={controller}
        snapshot={Object.freeze({ ...snapshot, analysis: matchingAnalysis })}
        imageRequest={request}
        onImageRequestHandled={handled}
      />
    </main>,
  );
  await waitFor(() => expect(insertImage).toHaveBeenCalled());
  expect(handled).toHaveBeenCalledWith(request.id);
});

it('discards an image request from the previous page after navigation', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  });
  const analysis = analysisFixture();
  const nextAnalysis = Object.freeze({
    ...analysis,
    pageIndex: 1,
    textLayout: Object.freeze({ ...analysis.textLayout, pageIndex: 1 }),
  });
  const controller = readyController({
    analysis: nextAnalysis,
    pageIndex: 1,
    pageCount: 2,
  });
  const insertImage = vi.fn().mockResolvedValue(undefined);
  Object.assign(controller, {
    getDisplayPage: vi.fn(async () => ({
      getViewport: ({ scale = 1 }: { scale?: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
      }),
    })),
    insertImage,
  });
  const snapshot = controller.getSnapshot() as EditorSnapshot;
  const request = {
    id: 2,
    file: new File([Uint8Array.of(1)], 'stamp.png', { type: 'image/png' }),
    generation: snapshot.generation,
    pageIndex: 0,
  };
  const handled = vi.fn();
  render(
    <PdfPageView
      controller={controller}
      snapshot={snapshot}
      imageRequest={request}
      onImageRequestHandled={handled}
    />,
  );

  await waitFor(() => expect(handled).toHaveBeenCalledWith(request.id));
  expect(insertImage).not.toHaveBeenCalled();
});

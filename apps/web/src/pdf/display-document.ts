import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | undefined;

function pdfJs(): Promise<typeof import('pdfjs-dist')> {
  pdfJsPromise ??= import('pdfjs-dist').then((module) => {
    module.GlobalWorkerOptions.workerSrc = workerUrl;
    return module;
  });
  return pdfJsPromise;
}

export class PdfDisplayDocument {
  private constructor(
    private readonly loadingTask: PDFDocumentLoadingTask,
    private readonly document: PDFDocumentProxy,
  ) {}

  static async open(bytes: Uint8Array): Promise<PdfDisplayDocument> {
    const ownedBytes = new Uint8Array(bytes);
    const { getDocument } = await pdfJs();
    const loadingTask = getDocument({ data: ownedBytes });
    const document = await loadingTask.promise;
    return new PdfDisplayDocument(loadingTask, document);
  }

  get pageCount(): number {
    return this.document.numPages;
  }

  getPage(pageIndex: number): Promise<PDFPageProxy> {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      return Promise.reject(new RangeError('Page index is outside the document'));
    }
    return this.document.getPage(pageIndex + 1);
  }

  destroy(): Promise<void> {
    return this.loadingTask.destroy();
  }
}

export async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  signal: AbortSignal,
): Promise<Readonly<{ width: number; height: number }>> {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('Render scale must be finite and positive');
  }

  const { RenderingCancelledException } = await pdfJs();
  const viewport = page.getViewport({ scale });
  const outputScale = globalThis.devicePixelRatio || 1;
  canvas.width = Math.ceil(viewport.width * outputScale);
  canvas.height = Math.ceil(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const renderTask = page.render({
    canvas,
    viewport,
    transform: outputScale === 1
      ? undefined
      : [outputScale, 0, 0, outputScale, 0, 0],
  });
  const cancel = (): void => renderTask.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  try {
    await renderTask.promise;
  } catch (error) {
    if (!(error instanceof RenderingCancelledException)) throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }

  return Object.freeze({ width: viewport.width, height: viewport.height });
}

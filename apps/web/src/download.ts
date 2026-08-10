import type { DownloadAsset } from './session/editor-controller';

export function editedFileName(source: string): string {
  const leaf = source.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const stem = leaf
    .replace(/\.pdf$/i, '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '-')
    .replace(/^[ ._-]+|[ ._-]+$/g, '');
  return `${stem || 'document'}-edited.pdf`;
}

export function downloadPdf(asset: DownloadAsset): void {
  const bytes = Uint8Array.from(asset.bytes);
  const url = URL.createObjectURL(new Blob(
    [bytes.buffer],
    { type: 'application/pdf' },
  ));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = editedFileName(asset.sourceFileName);
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

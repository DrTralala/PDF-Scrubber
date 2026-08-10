import { expect, it, vi } from 'vitest';

import { downloadPdf, editedFileName } from './download';

it.each([
  ['report.pdf', 'report-edited.pdf'],
  ['report.final.PDF', 'report.final-edited.pdf'],
  ['../ unsafe?.pdf', 'unsafe-edited.pdf'],
])('sanitises %s', (source, expected) => {
  expect(editedFileName(source)).toBe(expected);
});

it('clicks one PDF download and revokes its object URL', () => {
  vi.useFakeTimers();
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: () => '' },
    revokeObjectURL: { configurable: true, value: () => undefined },
  });
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-scrubber');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);

  downloadPdf({
    sourceFileName: 'report.pdf',
    bytes: Uint8Array.of(1, 2, 3),
  });

  expect(create.mock.calls[0]![0]).toBeInstanceOf(Blob);
  expect((create.mock.calls[0]![0] as Blob).type).toBe('application/pdf');
  expect(click).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith('blob:pdf-scrubber');
});

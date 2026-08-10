import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { deferred, fakeFontDescriptor } from '../test/fakes';
import { MissingFontsDialog } from './missing-fonts-dialog';

it('renders scanning, empty, and failed inventory states', () => {
  const registerFont = vi.fn();
  const onClose = vi.fn();
  const { rerender } = render(<MissingFontsDialog
    inventoryState="scanning"
    editingFonts={[]}
    registerFont={registerFont}
    onClose={onClose}
  />);
  expect(screen.getByRole('dialog', { name: 'Fonts needed for editing' })).toBeTruthy();
  expect(screen.getByText('Inspecting fonts needed for editing…')).toBeTruthy();

  rerender(<MissingFontsDialog inventoryState="ready" editingFonts={[]}
    registerFont={registerFont} onClose={onClose} />);
  expect(screen.getByText('No document fonts require a separate editing font.')).toBeTruthy();

  rerender(<MissingFontsDialog inventoryState="failed" editingFonts={[]}
    registerFont={registerFont} onClose={onClose} />);
  expect(screen.getByText('We could not inspect this PDF’s font resources.')).toBeTruthy();
});

it('explains why each original PDF font needs a separate editing file', () => {
  render(<MissingFontsDialog
    inventoryState="ready"
    editingFonts={[
      { name: 'MissingFace', reason: 'not-embedded' },
      { name: 'EmbeddedFace', reason: 'embedded-not-reusable' },
      { name: 'Helvetica', reason: 'standard-font' },
    ]}
    registerFont={vi.fn()}
    onClose={vi.fn()}
  />);

  expect(screen.getByText('This font is not embedded in the PDF.')).toBeTruthy();
  expect(screen.getByText('Embedded for display, but PDF-Scrubber cannot reuse it for editing.'))
    .toBeTruthy();
  expect(screen.getByText(
    'A separate font file is required to preserve this standard PDF font while editing.',
  )).toBeTruthy();
});

it('builds the exact safe new-tab download destination', () => {
  render(<MissingFontsDialog
    inventoryState="ready"
    editingFonts={[{ name: 'DejaVuSans', reason: 'not-embedded' }]}
    registerFont={vi.fn()}
    onClose={vi.fn()}
  />);
  const link = screen.getByRole('link', { name: 'Download DejaVuSans' });
  expect(link.getAttribute('href')).toBe('https://fonts2u.com/search.html?q=DejaVuSans');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

it('registers any selected supported face for the tab without claiming PDF changes', async () => {
  const registration = deferred<ReturnType<typeof fakeFontDescriptor>>();
  const registerFont = vi.fn().mockReturnValue(registration.promise);
  render(<MissingFontsDialog
    inventoryState="ready"
    editingFonts={[
      { name: 'Original Source Face', reason: 'not-embedded' },
      { name: 'Other Source Face', reason: 'embedded-not-reusable' },
    ]}
    registerFont={registerFont}
    onClose={vi.fn()}
  />);

  const sourceFace = screen.getByText('Original Source Face', { exact: true });
  const otherFace = screen.getByText('Other Source Face', { exact: true });

  await userEvent.upload(
    screen.getByLabelText('Choose font file for Original Source Face'),
    new File([Uint8Array.of(1, 2, 3)], 'different-face.ttf', { type: 'font/ttf' }),
  );
  expect(registerFont).toHaveBeenCalledWith('different-face.ttf', Uint8Array.of(1, 2, 3));
  expect(screen.getByText('Registering and checking font…')).toBeTruthy();

  registration.resolve(fakeFontDescriptor('upload', 'different-face.ttf'));
  expect(await screen.findByText(
    'Example Regular registered for this tab. The source PDF was not changed.',
  )).toBeTruthy();
  expect(sourceFace.isConnected).toBe(true);
  expect(otherFace.isConnected).toBe(true);
});

it('keeps import state per row, accepts supported formats, and resets the input', async () => {
  const registration = deferred<ReturnType<typeof fakeFontDescriptor>>();
  const registerFont = vi.fn().mockReturnValue(registration.promise);
  render(<MissingFontsDialog
    inventoryState="ready"
    editingFonts={[
      { name: 'Missing First', reason: 'not-embedded' },
      { name: 'Missing Second', reason: 'embedded-not-reusable' },
    ]}
    registerFont={registerFont}
    onClose={vi.fn()}
  />);

  const firstInput = screen.getByLabelText('Choose font file for Missing First') as HTMLInputElement;
  expect(firstInput.getAttribute('accept')).toBe(
    '.ttf,.otf,.woff,font/ttf,font/otf,font/woff',
  );
  await userEvent.upload(
    firstInput,
    new File([Uint8Array.of(1)], 'face.ttf', { type: 'font/ttf' }),
  );

  expect(firstInput.value).toBe('');
  expect(screen.getByRole('button', { name: 'Import Missing First' }))
    .toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Import Missing Second' }))
    .toHaveProperty('disabled', false);

  registration.resolve(fakeFontDescriptor('upload', 'face.ttf'));
  await screen.findByText(
    'Example Regular registered for this tab. The source PDF was not changed.',
  );
});

it('uses controlled registration errors and closes accessibly', async () => {
  const onClose = vi.fn();
  const registerFont = vi.fn().mockRejectedValue({ code: 'FONT_UNAVAILABLE' });
  render(<MissingFontsDialog inventoryState="ready"
    editingFonts={[{ name: 'Missing Face', reason: 'standard-font' }]}
    registerFont={registerFont} onClose={onClose} />);

  await waitFor(() => expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Close' }),
  ));
  await userEvent.upload(
    screen.getByLabelText('Choose font file for Missing Face'),
    new File([Uint8Array.of(1)], 'bad.ttf', { type: 'font/ttf' }),
  );
  expect(await screen.findByText(/static single-face TTF, CFF-OTF, or WOFF1/)).toBeTruthy();

  const dialog = screen.getByRole('dialog');
  const cancel = createEvent('cancel', dialog, { cancelable: true });
  fireEvent(dialog, cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('reports an unreadable selected file and re-enables its import controls', async () => {
  const registerFont = vi.fn();
  render(<MissingFontsDialog
    inventoryState="ready"
    editingFonts={[{ name: 'Unreadable Face', reason: 'not-embedded' }]}
    registerFont={registerFont}
    onClose={vi.fn()}
  />);
  const input = screen.getByLabelText(
    'Choose font file for Unreadable Face',
  ) as HTMLInputElement;
  const file = new File([Uint8Array.of(1)], 'unreadable.ttf', { type: 'font/ttf' });
  vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('private file read detail'));

  await userEvent.upload(input, file);

  expect(await screen.findByText('The selected font file could not be read.')).toBeTruthy();
  expect(registerFont).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Import Unreadable Face' }))
    .toHaveProperty('disabled', false);
  expect(input).toHaveProperty('disabled', false);
});

it('uses controlled copy for an unknown registration failure and re-enables controls', async () => {
  const registerFont = vi.fn().mockRejectedValue(new Error('private registration detail'));
  render(<MissingFontsDialog
    inventoryState="ready"
    editingFonts={[{ name: 'Unknown Failure Face', reason: 'not-embedded' }]}
    registerFont={registerFont}
    onClose={vi.fn()}
  />);
  const input = screen.getByLabelText(
    'Choose font file for Unknown Failure Face',
  ) as HTMLInputElement;

  await userEvent.upload(
    input,
    new File([Uint8Array.of(1)], 'unknown.ttf', { type: 'font/ttf' }),
  );

  expect(await screen.findByText(
    'The font could not be registered. Upload a supported font file or choose another local font.',
  )).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Import Unknown Failure Face' }))
    .toHaveProperty('disabled', false);
  expect(input).toHaveProperty('disabled', false);
});

it('closes when the explicit Close button is activated', async () => {
  const onClose = vi.fn();
  render(<MissingFontsDialog
    inventoryState="ready"
    editingFonts={[]}
    registerFont={vi.fn()}
    onClose={onClose}
  />);

  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

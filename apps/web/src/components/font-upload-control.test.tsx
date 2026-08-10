import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { BrowserLocalFontProvider } from '../fonts/local-font-provider';
import { fakeFontDescriptor } from '../test/fakes';
import { FontUploadControl } from './font-upload-control';

const target = Object.freeze({
  generation: 1,
  pageIndex: 0,
  selectionKey: 'selection-1',
  range: Object.freeze({ start: 1, end: 4 }),
});

const requirement = Object.freeze({
  kind: 'ready' as const,
  requirement: Object.freeze({
    postscriptName: 'DejaVuSans-Bold',
    family: 'dejavusans',
    weight: 700,
    italic: false,
  }),
});

test('uploads owned font bytes and reports explicit application', async () => {
  const descriptor = fakeFontDescriptor('upload', 'face.ttf');
  const applyFont = vi.fn().mockResolvedValue({ descriptor, outcome: 'applied' });
  render(
    <FontUploadControl
      applyFont={applyFont}
      target={target}
      requirement={requirement}
    />,
  );
  const source = Uint8Array.of(1, 2, 3);
  const file = new File([source], 'face.ttf', { type: 'font/ttf' });

  await userEvent.upload(screen.getByLabelText('Upload and apply font'), file);

  expect(applyFont).toHaveBeenCalledWith('upload', 'face.ttf', source, target);
  expect(screen.getByText('Example Regular applied. Reshaping text…')).toBeTruthy();
});

test('discovers an exact cached match and reads its bytes only on explicit use', async () => {
  const bytes = Uint8Array.of(4, 5, 6);
  const blob = vi.fn(async () => new Blob([bytes]));
  const provider = new BrowserLocalFontProvider({
    isSecureContext: true,
    queryLocalFonts: vi.fn(async () => [{
      postscriptName: 'DejaVuSans-Bold',
      fullName: 'DejaVu Sans Bold',
      family: 'DejaVu Sans',
      style: 'Bold',
      blob,
    }]),
  });
  const descriptor = fakeFontDescriptor('local', 'DejaVuSans-Bold.font');
  const applyFont = vi.fn().mockResolvedValue({ descriptor, outcome: 'applied' });
  const user = userEvent.setup();
  render(
    <FontUploadControl
      applyFont={applyFont}
      target={target}
      requirement={requirement}
      provider={provider}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Enable local fonts' }));

  expect(await screen.findByText('Matching local font found: DejaVu Sans Bold.')).toBeTruthy();
  expect(blob).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Use matching local font' }));
  expect(blob).toHaveBeenCalledOnce();
  expect(applyFont).toHaveBeenCalledWith(
    'local',
    'DejaVuSans-Bold.font',
    bytes,
    target,
  );
  expect(screen.getByText('Example Regular applied. Reshaping text…')).toBeTruthy();
});

test('does not offer one-click matching for a mixed selection', async () => {
  const provider = new BrowserLocalFontProvider({
    isSecureContext: true,
    queryLocalFonts: vi.fn(async () => [{
      postscriptName: 'DejaVuSans-Bold',
      fullName: 'DejaVu Sans Bold',
      family: 'DejaVu Sans',
      style: 'Bold',
      blob: vi.fn(async () => new Blob([Uint8Array.of(1)])),
    }]),
  });
  render(
    <FontUploadControl
      applyFont={vi.fn()}
      target={target}
      requirement={{ kind: 'mixed', reason: 'mixed-font-requirement' }}
      provider={provider}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'Enable local fonts' }));

  expect(await screen.findByText(/selection uses mixed font requirements/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use matching local font' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Use selected local font' })).toBeTruthy();
});

test.each([
  ['stale-selection', /registered for this tab, but the selection changed/],
  ['missing-coverage', /does not cover all selected characters/],
] as const)('reports the %s outcome without claiming application', async (outcome, expected) => {
  const descriptor = fakeFontDescriptor('upload', 'face.ttf');
  const applyFont = vi.fn().mockResolvedValue({ descriptor, outcome });
  render(
    <FontUploadControl
      applyFont={applyFont}
      target={target}
      requirement={requirement}
    />,
  );

  await userEvent.upload(
    screen.getByLabelText('Upload and apply font'),
    new File([Uint8Array.of(1)], 'face.ttf', { type: 'font/ttf' }),
  );

  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.queryByText(/applied\. Reshaping/)).toBeNull();
});

test.each([
  ['FONT_UNAVAILABLE', /static single-face TTF, CFF-OTF, or WOFF1/],
  ['FONT_EMBEDDING_PROHIBITED', /does not permit embedding for document editing/],
  ['RESOURCE_LIMIT', /supported processing limit/],
] as const)('classifies %s without exposing engine detail', async (code, expected) => {
  const error = Object.assign(new Error('private font detail'), { code });
  render(
    <FontUploadControl
      applyFont={vi.fn().mockRejectedValue(error)}
      target={target}
      requirement={requirement}
    />,
  );

  await userEvent.upload(
    screen.getByLabelText('Upload and apply font'),
    new File([Uint8Array.of(1)], 'face.ttf', { type: 'font/ttf' }),
  );

  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.queryByText(/private font detail/)).toBeNull();
});

test('explains insecure and unsupported Local Font Access environments', () => {
  const applyFont = vi.fn();
  const { unmount } = render(
    <FontUploadControl
      applyFont={applyFont}
      target={target}
      requirement={requirement}
      provider={new BrowserLocalFontProvider({ isSecureContext: false })}
    />,
  );
  expect(screen.getByText(/HTTPS or http:\/\/localhost:5173/)).toBeTruthy();
  expect(screen.getByLabelText('Upload and apply font')).toBeTruthy();
  unmount();

  render(
    <FontUploadControl
      applyFont={applyFont}
      target={target}
      requirement={requirement}
      provider={new BrowserLocalFontProvider({ isSecureContext: true })}
    />,
  );
  expect(screen.getByText(/desktop Chrome or Edge/)).toBeTruthy();
  expect(screen.getByLabelText('Upload and apply font')).toBeTruthy();
});

test.each([
  [
    new DOMException('Permission denied', 'NotAllowedError'),
    /Allow local fonts for this site in your browser settings/,
  ],
  [
    new DOMException('Policy blocked', 'SecurityError'),
    /organisation's Permissions Policy/,
  ],
])('explains rejected Local Font Access requests', async (error, expected) => {
  const user = userEvent.setup();
  const provider = new BrowserLocalFontProvider({
    isSecureContext: true,
    queryLocalFonts: vi.fn(async () => Promise.reject(error)),
  });
  render(
    <FontUploadControl
      applyFont={vi.fn()}
      target={target}
      requirement={requirement}
      provider={provider}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Enable local fonts' }));

  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.getByLabelText('Upload and apply font')).toBeTruthy();
});

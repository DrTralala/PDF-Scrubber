import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { FontRequirementPanel } from './font-requirement-panel';

it('removes PDF subset tags from requested font names shown to users', () => {
  render(<FontRequirementPanel
    statuses={[{
      key: 'font-status',
      requestedName: 'CAAAAA+Arial',
      fontId: 'font:noto-sans',
      actualName: 'Noto Sans Regular',
      source: 'bundled',
      matchKind: 'substitute',
      reasons: ['font-substitution-required'],
    }]}
    consents={[]}
    onConsent={vi.fn()}
  />);

  expect(screen.getByText('Arial', { exact: true })).toBeTruthy();
  expect(screen.queryByText('CAAAAA+Arial', { exact: true })).toBeNull();
  expect(screen.getByRole('checkbox', {
    name: 'Allow Noto Sans Regular for Arial',
  })).toBeTruthy();
});

it('preserves requested font names without PDF subset tags', () => {
  render(<FontRequirementPanel
    statuses={[{
      key: 'font-status',
      requestedName: 'Times New Roman',
      fontId: null,
      actualName: null,
      source: null,
      matchKind: 'unavailable',
      reasons: ['no-fonts-registered'],
    }]}
    consents={[]}
    onConsent={vi.fn()}
  />);

  expect(screen.getByText('Times New Roman', { exact: true })).toBeTruthy();
});

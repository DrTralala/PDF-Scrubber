import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './app';

describe('PDF-Scrubber app shell', () => {
  it('starts with one local PDF action and the measured limit', () => {
    render(<App />);
    expect(screen.getByText('PDF-Scrubber')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open a PDF to edit text' })).toBeTruthy();
    expect(screen.getByLabelText('Open PDF')).toBeTruthy();
    expect(screen.getByText(/15 MiB maximum/)).toBeTruthy();
    expect(screen.queryByText(/add image/i)).toBeNull();
  });
});

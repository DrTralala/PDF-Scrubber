import { describe, expect, test } from 'vitest';

import { isAllowedHarnessUrl } from '../../../tools/check-no-network';

describe('browser harness network policy', () => {
  test.each([
    'http://[::1]:4173/fixture.pdf',
    'https://localhost/font.woff',
    'http://127.0.0.1:5173/',
    'blob:http://[::1]:4173/id',
    'data:application/octet-stream;base64,AA==',
  ])('allows local or in-memory URL %s', (url) => {
    expect(isAllowedHarnessUrl(url)).toBe(true);
  });

  test.each([
    'https://example.com/font.woff',
    'http://192.0.2.1/document.pdf',
    'wss://example.com/socket',
  ])('rejects remote URL %s', (url) => {
    expect(isAllowedHarnessUrl(url)).toBe(false);
  });
});

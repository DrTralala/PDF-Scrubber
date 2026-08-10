export function fontRegistrationErrorMessage(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'FONT_UNAVAILABLE') {
    return 'This font is unsupported. Use a static single-face TTF, CFF-OTF, or WOFF1 font.';
  }
  if (code === 'FONT_EMBEDDING_PROHIBITED') {
    return 'This font does not permit embedding for document editing.';
  }
  if (code === 'RESOURCE_LIMIT') {
    return 'This font exceeds a supported processing limit.';
  }
  return 'The font could not be registered. Upload a supported font file or choose another local font.';
}

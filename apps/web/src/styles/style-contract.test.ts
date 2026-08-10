import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function requiredRule(css: string, selector: RegExp): string {
  const match = css.match(selector);
  expect(match?.[1]).toBeDefined();
  return match?.[1] ?? '';
}

describe('PDF-Scrubber visual contract', () => {
  it('uses the approved local, responsive, reduced-motion design tokens', async () => {
    const css = await readFile(
      resolve(process.cwd(), 'apps/web/src/styles/app.css'),
      'utf8',
    );
    for (const token of [
      '--ink: #e7edf4',
      '--surface: #141b23',
      '--chrome: #1b2530',
      '--drafting: #0b1016',
      '--signal: #ff7651',
      '--safe: #54c7b5',
      '--pdf-paper: #ffffff',
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toContain('color-scheme: dark');
    expect(css).toMatch(/\.page-frame\s*\{[^}]*background:\s*var\(--pdf-paper\)/s);
    expect(css).toMatch(/\.page-frame canvas\s*\{[^}]*background:\s*var\(--pdf-paper\)/s);
    expect(css).not.toMatch(
      /(?:\.page-frame|\.page-frame canvas)[^{]*\{[^}]*(?:filter|mix-blend-mode):/s,
    );
    expect(css).toContain("'IBM Plex Sans'");
    expect(css).toContain("'IBM Plex Mono'");
    expect(css).toContain('@media (max-width: 800px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.text-group-overlay[aria-pressed="true"]');
    expect(css).toContain(".editor[data-tool='pan'] .text-selection-hit-layer");
    expect(css).toContain('.format-toolbar');
    expect(css).toContain('.font-requirements');
    expect(css).toContain('.missing-fonts-dialog');
    expect(css).toContain('.fit-status');
    expect(css).toContain('.font-source-controls');
    expect(css).toContain('.rich-allowed-region');
    expect(css).toContain('.rich-preview-text');
    expect(css).toMatch(
      /\.format-buttons\s+\.text-colour-control\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    );
    expect(css).not.toMatch(/\.format-buttons\s+label\s*(?:,|\{)/);
    expect(css).toContain(':focus-visible');
    expect(css).not.toContain('linear-gradient(');
    expect(css).not.toMatch(/url\(["']?https?:/);

    const modalShell = requiredRule(
      css,
      /\.reset-dialog\s*,\s*\.missing-fonts-dialog\s*\{([^}]*)\}/s,
    );
    expect(modalShell).toMatch(
      /\bwidth\s*:\s*min\(\s*32rem\s*,\s*calc\(\s*100vw\s*-\s*2rem\s*\)\s*\)\s*;/,
    );
    expect(modalShell).toMatch(
      /\bmax-height\s*:\s*min\(\s*36rem\s*,\s*calc\(\s*100vh\s*-\s*2rem\s*\)\s*\)\s*;/,
    );
    expect(modalShell).toMatch(/\boverflow\s*:\s*auto\s*;/);
    expect(modalShell).toMatch(/\bborder\s*:\s*1px\s+solid\s+var\(\s*--ink\s*\)\s*;/);
    expect(modalShell).toMatch(/\bborder-top\s*:\s*4px\s+solid\s+var\(\s*--signal\s*\)\s*;/);
    expect(modalShell).toMatch(/\bborder-radius\s*:\s*0\s*;/);

    const narrowRules = requiredRule(
      css,
      /@media\s*\(\s*max-width\s*:\s*800px\s*\)\s*\{([\s\S]*?)(?=@media\s*\()/,
    );
    expect(narrowRules).toMatch(
      /\.missing-font-row\s*\{[^}]*\bgrid-template-columns\s*:\s*1fr\s*;/s,
    );
    expect(narrowRules).toMatch(
      /\.missing-font-actions\s*\{[^}]*\bjustify-content\s*:\s*flex-start\s*;/s,
    );
  });
});

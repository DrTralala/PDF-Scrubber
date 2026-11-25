# PDF-Scrubber

[![Verify](https://github.com/DrTralala/PDF-Scrubber/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/PDF-Scrubber/actions/workflows/verify.yml)
[![Version](https://img.shields.io/github/v/release/DrTralala/PDF-Scrubber?label=version&color=blue&sort=date&style=flat-square)](https://github.com/DrTralala/PDF-Scrubber/releases/latest)
[![Licence: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 24.22.1](https://img.shields.io/badge/Node.js-24.22.1-339933.svg)](https://nodejs.org/)

Edit existing text in supported machine-readable PDFs in a local browser editor. PDF-Scrubber keeps PDF and uploaded-font processing in the browser; its CLI serves the editor on loopback only.

[Quick start](#quick-start) · [Capabilities and limits](#capabilities-and-limits) · [Windows portable app](#windows-portable-app) · [Development](#source-development) · [Project structure](#project-structure)

## Quick start

You need Node.js 24.22.1 and npm. No global installation or additional configuration is required.

> [!IMPORTANT]
> The CLI binds to `127.0.0.1`. Keep it on loopback, and use the printed loopback URL. If you need Local Font Access, do not open the editor through a WSL network URL.

Run the latest published CLI without installing it globally:

```bash
npx pdf-scrubber@latest
```

For a reproducible run, pin the package version:

```bash
npx pdf-scrubber@1.2.0
```

The CLI prints a local URL and tries to open it in your browser. It uses port `5173` by default and selects an available fallback port if needed. If the browser does not open, visit the printed URL. Press **Ctrl-C** to stop the server.

1. Choose a supported PDF or drop it on the opening screen. Files larger than 15 MiB are rejected.
2. Select editable text and enter a replacement. Wait for **Replacement is ready**, review any font-substitution prompt, then choose **Apply replacement**.
3. Choose **Download copy** to save the edited PDF. The source file is not overwritten.

## Capabilities and limits

- **Replace existing text:** compatible text is grouped into editable fields and lines. Mixed style runs and recognised text decorations are preserved where supported.
- **Check before applying:** the editor previews replacements, checks fit and validates edits before making a copy available to download.
- **Keep processing local:** PDF and uploaded-font bytes are processed in the browser, not sent to the local static server.

The editor only works with supported machine-readable text. It does not add text or images, perform OCR on scanned pages, reflow paragraphs or provide per-change undo. **Reset** restores the original PDF and removes all replacements. Text the editor marks read-only cannot be changed. The PDF engine accepts unfiltered streams and single `/FlateDecode` streams; it rejects other stream filters and multi-filter chains.

The current engine limits are:

| Resource | Limit |
| --- | ---: |
| PDF file size | 15 MiB (`15,728,640` bytes) |
| Indirect objects | 2,000 |
| Nesting depth | 12 |
| Decoded stream size | 4 MiB |
| Operations per content stream | 50,000 |
| Page image area | 12 megapixels |
| Processing time | 30 seconds |

A PDF below 15 MiB can still exceed another limit. Unsupported PDF features or malformed content may also prevent editing.

## Windows portable app

The launcher is unsigned, so Windows may show a security warning. Portable does not mean that no operating-system traces are created: Windows, drivers, security software, native dialogs, paging or crash collection may write data outside the application folder.

Stable, non-prerelease [GitHub releases](https://github.com/DrTralala/PDF-Scrubber/releases/latest) include a tested Windows x64 portable archive (`PDF-Scrubber-<version>-win-x64-portable.7z`) and its SHA-256 checksum. Extract the complete `PDF-Scrubber/` folder and run its root `PDF-Scrubber.exe`:

```text
PDF-Scrubber/
  PDF-Scrubber.exe
  settings.json
  config/
```

Do not copy or run only the root executable. The launcher starts the packaged Electron runtime from `config/`; it does not unpack the runtime on launch. No separate Node.js installation or installer is needed. Move the entire folder only when the app is closed.

The user-editable `settings.json` is at the application root. Its schema is strict: `schemaVersion` must be `1`, `window.width` an integer from 760 through 16384, and `window.height` an integer from 560 through 16384. Defaults are:

```json
{
  "schemaVersion": 1,
  "window": { "width": 1280, "height": 860 }
}
```

Unknown keys, malformed or unsupported settings, and dimensions outside those bounds produce a visible error; invalid settings are not silently overwritten. If the file is missing, the app creates it with these defaults when the folder is writable. Move the complete application folder to a writable location rather than running it as administrator.

The app keeps its managed runtime, profile, cache, logs, temporary files and crash-report data under `config/`. For a manual update, close the old copy and extract the new release to a separate folder. With both copies closed, copy the validated `settings.json` and old `config/profile/` into the new folder. Do not copy old files over `config/runtime/` or blindly replace your settings with shipped defaults. Existing AppData profiles are not migrated or removed automatically.

Maintainers can dispatch the [Windows portable workflow](.github/workflows/desktop.yml) with an existing stable `editor_tag` (for example, `v1.1.0`) to build a workflow artifact without publishing or modifying a release. A manual build uses the editor from that tag and the packaging wrapper from the selected workflow revision; it does not attach files to a release.

## Source development

The workspace requires the exact Node.js version in `package.json` and the lockfile: 24.22.1. From the repository root:

```bash
npm ci
npm start
```

`npm start` runs the Vite development server. Open its printed loopback URL. Use that local URL, not a WSL network URL, when Local Font Access is needed.

Run the focused checks from the repository root:

```bash
npm run typecheck
npm run test:unit
npm run test:web:unit
npm run build:web
```

Generate fixtures before running product browser tests. Port `5173` must be free; the Playwright suite starts its own strict-port test server.

```bash
npm run build:fixtures
npm run test:web
```

The routine browser run includes the existing tests and committed Suite 1. To include Suites 1–3:

```bash
npm run test:web -- --full
```

The browser test runner validates the committed synthetic PDFs' manifests and hashes, PDF readability and metadata; it does not regenerate them. The explicit `npm run build:fixtures` step above is separate. The canonical Linux release gate is `npm run verify:release`; it requires a fresh M0 report with `## Decision: GO` and also checks that port `5173` is free around browser tests. M0 reports and runtime evidence are written under ignored `artifacts/m0/`.

Large public-PDF validation is opt-in. It downloads about 25 MiB into temporary storage, validates the pinned PDFs and removes those downloads afterwards:

```bash
npm run validate:large-pdfs
```

## Project structure

| Path | Responsibility |
| --- | --- |
| `apps/web/` | React/Vite browser editor and browser tests |
| `apps/cli/` | Public npm CLI package; the only published workspace package |
| `apps/desktop/` | Private Electron wrapper and Windows portable packaging |
| `packages/pdf-engine/` | PDF analysis, mutation, shaping, validation and export |
| `packages/worker-protocol/` | Worker message types and transfer helpers |
| `packages/test-support/` | Fixture, rendering, diff and validation helpers |
| `fixtures/generated/` | Committed synthetic PDFs used by tests |
| `tests/1`, `tests/2`, `tests/3` | Committed multi-language PDF validation suites |
| `tools/` | Test runners, PDF inspection, fixture validation and project checks |

The root workspace and internal packages are private; only `apps/cli/` is published to npm. Stable GitHub releases also include the tested Windows archive and checksum.

## Licence

PDF-Scrubber is distributed under the [MIT licence](LICENSE). The Windows portable launcher is unsigned; see the warning above before running it.

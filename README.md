# PDF-Scrubber

[![CI](https://github.com/DrTralala/PDF-Scrubber/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/PDF-Scrubber/actions/workflows/verify.yml)
[![Version](https://img.shields.io/github/v/release/DrTralala/PDF-Scrubber?label=version&color=blue&sort=date&style=flat-square)](https://github.com/DrTralala/PDF-Scrubber/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24.18.0-339933.svg)](https://nodejs.org/)

PDF-Scrubber lets you replace supported machine-readable PDF text in a browser while keeping document and font processing local. It groups compatible left-to-right glyphs into editable fields and visual lines, preserves mixed style runs and recognised text decorations, and validates replacements before download. It cannot add text or images, edit scanned text, reflow paragraphs, or undo changes.

## Quick start

Requires Node.js 24.18.0. npm must be available to run `npx` and the source checkout. No additional configuration is needed for a local run.

The CLI uses loopback-only serving. PDF and uploaded font bytes stay in the browser and are not sent to a server.

Run the published CLI without installing it globally:

```bash
npx pdf-scrubber@latest
```

The CLI prints a loopback URL and tries to open it in your browser. If it cannot open a browser, use the printed URL. In the editor:

1. Choose a supported PDF or drop it on the opening screen. Files over 15 MiB are rejected.
2. Select editable text and enter a replacement. Wait for `Replacement is ready`, then choose `Apply replacement`.
3. Choose `Download copy` to save the edited PDF.

### Alternative installation methods

To run the pinned 1.1.0 release instead of the latest published version:

```bash
npx pdf-scrubber@1.1.0
```

To install the CLI globally instead:

```bash
npm install --global pdf-scrubber
pdf-scrubber
```

The CLI uses port 5173 by default and selects a fallback port when it is unavailable. Press Ctrl-C to shut it down.

## Source development

Build and run PDF-Scrubber from a source checkout:

```bash
npm ci
npm start
```

`npm start` launches the Vite development server. Open the printed loopback URL in your browser. Do not use the WSL network URL when Local Font Access is needed.

## Checks

```bash
npm run typecheck
npm run test:unit
npm run test:web:unit
npm run build:web
npm run build:fixtures

# Routine: existing browser tests plus committed Suite 1
npm run test:web

# Full: existing browser tests plus committed Suites 1–3
npm run test:web -- --full

npm run test:m0
```

Port 5173 must be free before either browser command because the Playwright suite starts its own strict-port test server. The committed PDFs are synthetic, manifest/hash verified, checked for PDF readability and metadata, and not regenerated during tests.

M0 reports and runtime evidence are written under ignored `artifacts/m0/`.

Large public-PDF validation is opt-in because it downloads roughly 25 MiB into temporary storage:

```bash
npm run validate:large-pdfs
```

The command verifies exact sizes, SHA-256 hashes, and PDF signatures for the pinned public PDFs, runs their dedicated browser checks, and removes the downloads afterwards.

## Windows portable app

Stable, non-prerelease releases include a tested Windows x64 portable `.7z` archive, a SHA-256 checksum, and source provenance on the same GitHub release. The archive is named `PDF-Scrubber-<version>-win-x64-portable.7z` and contains one `PDF-Scrubber/` folder with this root layout:

```text
PDF-Scrubber/
  PDF-Scrubber.exe
  settings.json
  config/
```

Download the archive and extract its entire `PDF-Scrubber/` folder, then run `PDF-Scrubber.exe` from that folder's root. The launcher starts the packaged Electron runtime under `config/` directly; it does not extract a runtime on launch. Moving the app means closing it and moving the entire folder. Do not copy or run only the root executable. The desktop app does not require a separately installed Node.js runtime or an installer.

Application-managed runtime, profile, cache, logs, temporary files, and crash-report data stay under `config/`. The user-facing `settings.json` file is at the application root. Schema version 1 is strict: `schemaVersion` must be `1`, `window.width` must be an integer from 760 through 16384, and `window.height` must be an integer from 560 through 16384. The default settings are:

```json
{"schemaVersion":1,"window":{"width":1280,"height":860}}
```

Unknown keys, malformed or unsupported settings, and dimensions outside those bounds fail visibly; malformed or invalid settings are not silently overwritten. If `settings.json` is missing, the documented defaults are created when the folder is writable.

For a manual update, close the old copy and extract the new release separately into a different folder. With both copies closed, preserve your validated `settings.json` by copying it into the new folder, and copy the old portable profile from `config/profile/` into the new folder's `config/profile/`. Do not copy old files over the new `config/runtime/`. Do not blindly overwrite your settings with shipped defaults. Existing AppData profiles are not migrated or removed automatically.

The launcher is unsigned, so Windows may show a security warning. Portable does not mean no operating-system traces: Windows, drivers, security software, native dialogs, paging, or crash collection may create data outside the application folder. This is not a zero-OS-traces guarantee.

To build a version manually without publishing or modifying a release, open **Actions → Windows portable → Run workflow**, enter an editor tag such as `v1.1.0`, and download the completed workflow artifact. Extract the `.7z` and run the root executable from the complete folder. The editor is built from that tag using its lockfile; the desktop wrapper and packaging configuration come from the selected workflow revision. Manual builds do not attach files to a release. This also allows a historical editor tag to be packaged with the current wrapper without changing that tag.

## PDF limits and compatibility

PDF-Scrubber applies these processing limits:

| Limit | Maximum |
| --- | ---: |
| PDF file size | 15 MiB (`15,728,640` bytes) |
| Indirect objects | 2,000 |
| Nesting depth | 12 |
| Decoded stream size | 4 MiB |
| Operations per content stream | 50,000 |
| Page image size | 12 megapixels |
| Processing time | 30 seconds |

A file below 15 MiB can still exceed one of the other limits. Edited PDFs produced before the rebrand remain readable. New controlled-redraw and page-isolation markers use `PDF-Scrubber`; compatibility tests continue to accept the previous marker format.

## Project structure

- `apps/web/` — React/Vite editor application and browser tests.
- `apps/desktop/` — secure Electron wrapper and Windows portable packaging configuration.
- `packages/pdf-engine/` — PDF analysis, mutation, shaping, validation, and export engine.
- `packages/worker-protocol/` — worker message types and transfer helpers.
- `packages/test-support/` — fixture, rendering, diff, and validation helpers.
- `fixtures/generated/` — committed synthetic PDFs used by unit and browser tests.
- `tests/1`, `tests/2`, `tests/3` — committed multi-language PDF validation suites.
- `tools/` — test runners, PDF inspection, fixture validation, and project policy checks.

## Release workflow

The publishable npm package is `apps/cli/`; the root workspace and internal packages remain
private. Release checks build the browser assets, verify the package contents, and run the CLI
smoke checks before a package is published.

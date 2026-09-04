# PDF-Scrubber

[![CI](https://github.com/DrTralala/PDF-Scrubber/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/PDF-Scrubber/actions/workflows/verify.yml)
[![Version](https://img.shields.io/badge/version-v1.0.0-blue.svg?style=flat-square)](https://github.com/DrTralala/PDF-Scrubber/tree/v1.0.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24.18.0-339933.svg)](https://nodejs.org/)

PDF-Scrubber edits supported machine-readable PDF text locally in the browser. It groups compatible left-to-right glyphs into editable fields and visual lines, preserves mixed style runs and recognised text decorations, and validates every candidate before enabling download. The first release replaces existing text only; it does not add text/images, edit scans, reflow paragraphs, or provide undo.

## Requirements

- System-managed Node.js 24.18.0
- npm 11.16.0

## Installation and run

Run the published CLI without a permanent installation:

```bash
npx pdf-scrubber@latest
```

For a reproducible stable release:

```bash
npx pdf-scrubber@1.0.0
```

For an optional global installation:

```bash
npm install --global pdf-scrubber
pdf-scrubber
```

The CLI uses loopback-only serving. It uses port 5173 by default, with a fallback port when that
port is unavailable. Open the printed loopback URL in your browser. Press
Ctrl-C to shut the server down.

## Source development

Build and run PDF-Scrubber from a source checkout:

```bash
npm ci
npm start
```

Open the printed loopback URL in your browser. Do not use the WSL network URL when Local Font
Access is needed. PDF-Scrubber accepts supported PDFs up to 15 MiB (`15,728,640` bytes) and does
not upload document bytes. Independent safeguards still limit PDFs to 2,000 indirect objects,
nesting depth 12, 4 MiB decoded streams, 50,000 operations per stream, 12-megapixel page images,
and 30-second operations; a file below 15 MiB can therefore still stop at a named processing
limit.

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

Large public-PDF validation is opt-in because it downloads roughly 25 MiB into temporary storage:

```bash
npm run validate:large-pdfs
```

The command verifies exact sizes, SHA-256 hashes, and PDF signatures for the pinned public PDFs, runs their dedicated browser checks, and removes the downloads afterwards.

## PDF compatibility and privacy

Edited PDFs produced before the rebrand remain readable. New controlled-redraw and page-isolation markers use `PDF-Scrubber`; compatibility tests continue to accept the previous marker format. Document bytes and uploaded font bytes remain in the browser tab and are not sent to a server.

## Project structure

- `apps/web/` — React/Vite editor application and browser tests.
- `packages/pdf-engine/` — PDF analysis, mutation, shaping, validation, and export engine.
- `packages/worker-protocol/` — worker message types and transfer helpers.
- `packages/test-support/` — fixture, rendering, diff, and validation helpers.
- `fixtures/generated/` — committed synthetic PDFs used by unit and browser tests.
- `tests/1`, `tests/2`, `tests/3` — committed multi-language PDF validation suites.
- `tools/` — test runners, PDF inspection, fixture validation, and project policy checks.

## Release workflow

The publishable npm package is `apps/cli/`; the root workspace and internal packages remain
private. Release checks build the browser assets, verify the package contents, and run the CLI
smoke checks before a package is published. There is no changelog section because release
metadata and documentation are updated together for each release.

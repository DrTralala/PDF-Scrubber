# PDF-Scrubber

PDF-Scrubber is a local browser editor for supported machine-readable PDF text.
It is designed to keep document and font processing in the browser.

## Usage

Run the CLI without a permanent installation:

```bash
npx pdf-scrubber
```

For an optional global installation:

```bash
npm install --global pdf-scrubber
pdf-scrubber
```

PDF-Scrubber requires Node.js 24.18.0. The local server listens on loopback
only. It uses port 5173 by default and selects a fallback port when that port
is unavailable. Press Ctrl-C to shut the server down.

PDF and font processing remains local to the browser; document and font bytes
are not uploaded to a server.

The CLI runtime is being assembled incrementally; this package version
establishes its public npm package boundary and metadata.

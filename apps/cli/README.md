# PDF-Scrubber

PDF-Scrubber is a local browser editor for supported machine-readable PDF text.
It is designed to keep document and font processing in the browser.

## Usage

Run the CLI without a permanent installation:

```bash
npx pdf-scrubber@latest
```

For a reproducible stable release:

```bash
npx pdf-scrubber@1.3.0
```

For an optional global installation:

```bash
npm install --global pdf-scrubber
pdf-scrubber
```

PDF-Scrubber requires Node.js 24.22.1. The local server listens on loopback
only. It uses port 5173 by default and selects a fallback port when that port
is unavailable. Press Ctrl-C to shut the server down.

PDF and font processing remains local to the browser; document and font bytes
are not uploaded to a server. The GitHub source is public; see the repository
README for source development and project checks.

Use **Auto** to fit a longer text replacement, then choose **Apply**. You can
also insert a local PNG or JPEG, move it and resize it on the page. Choose
**Save** to overwrite the open PDF where the browser permits it, or **Save as...**
to save another file. In download-only browsers the original is not changed.

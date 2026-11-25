# PDF-Scrubber project instructions

## Repository and validation

- Keep `docs/` ignored and absent from tracked files. Store temporary plans outside the checkout; generated M0 reports belong in ignored `artifacts/m0/`.
- Preserve local-only PDF processing and the existing web/editor/CLI contracts. The desktop wrapper is private and must not enter the published npm package.
- Use the Node version in `package.json` and the lockfile. `scripts/verify.sh` is the canonical Linux release gate (`npm run verify:release`); a fresh `artifacts/m0/m0-results.md` must say `## Decision: GO`.
- Never run Playwright/M0 while another process listens on port 5173, on either address family. Do not stop a server you do not own without permission. Run fixture generation before product browser tests; Playwright owns its test-mode server.
- Retain the local `pdf-scrubber-run-validate` skill for supplementary browser checks and its evidence boundaries. Generic browser/verification skills do not replace its strict-port, rejection-mode and byte-integrity rules.

## Future stable releases

Every new stable release must deliver **both the npm package and the tested Windows x64 portable `.7z` archive containing its executable**. The workflows are `.github/workflows/publish.yml` and `.github/workflows/desktop.yml`; both run on a published stable GitHub Release. A successful npm publish alone is not a complete release.

1. Require one explicit, unused `MAJOR.MINOR.PATCH` version. Reject current/reused versions, partial/ranged versions, prereleases and build metadata. Begin on a clean `main`, synchronised with upstream. Confirm the Git tag and npm version are absent; lookup/authentication failures are blockers, not absence.
2. Update `apps/cli/package.json`, its lockfile entry and version-pinned README examples. Keep the root README's data-backed latest-release badge dynamic. Desktop staged metadata is derived from the selected editor version; do not independently label a different editor as that release.
3. Run focused release/package checks and `npm run verify:release`. Commit only intended changes and push normally with authorisation. Require the exact pushed SHA's `Verify` workflow to pass; a branch-name result or older run is insufficient.
4. Prepare complete release notes outside the checkout with finally-style cleanup. Show the version, exact SHA and notes, and obtain explicit confirmation before creating the public release/tag. Immediately beforehand recheck clean/synchronised main, unchanged approved SHA, absent tag/npm version and successful exact-SHA verification.
5. Create the GitHub Release targeting that exact SHA. Let GitHub Actions publish npm with OIDC; never handle npm publish tokens or run ordinary local `npm publish`. Do not force-push, rewrite tags/history or reuse versions as part of an ordinary release.
6. Watch **both** exact release-triggered workflows. Require the Windows job to smoke-test the actual root launcher from the final `.7z` after extraction (edit, readable downloaded PDF containing the edit, no external document requests, clean shutdown) before attaching assets. Verify the `.7z` archive and matching SHA-256 file are present on the release, and the workflow checks both source identities against the release commit.
7. Verify registry metadata for the exact npm version and perform a clean installed-package smoke. Report version/SHA, gates, both workflow results, release URL, archive/checksum, npm results and cleanup. Failed, missing, cancelled or mismatched runs block a complete-release claim.

## Historical desktop backfills

- Use manual `Windows portable` workflow dispatch with an existing stable `editor_tag`. It builds that tag's editor using that tag's lockfile, with the selected workflow revision's packaging wrapper. Manual runs upload Actions artefacts only.
- Keep historical tags and npm releases unchanged. Record editor SHA and packaging SHA separately; they intentionally differ for historical backfills.
- Attach assets to the existing release only with explicit authorisation, after the Windows archive smoke passes, the downloaded `.7z` checksum matches, and the workflow's editor and packaging identities match the requested tag and packaging revision. Do not recreate the release, retrigger npm publication, or silently overwrite existing assets.
- The launcher is unsigned: Windows may show a security warning. Portable means moving the entire closed folder, with no installer or separate Node installation; app-managed state stays under `config/`. This is not a zero-OS-traces guarantee because Windows and other software may create data outside the application folder.

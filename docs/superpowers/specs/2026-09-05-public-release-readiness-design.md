# Public Release Readiness Design

## Goal

Remove `.opencode` from the repository's reachable Git history, modernise the existing v1.0.0 GitHub Release, prepare but do not publish version 1.1.0, audit the final repository for sensitive information and public-readiness risks, and make the GitHub repository public only when every gate passes.

## Scope and constraints

- Remove the complete `## Supported editing` section from the root `README.md`.
- Keep `.opencode/` available as local ignored tooling, but remove it from every reachable commit and tag.
- Rewrite and force-update only `main` and `v1.0.0`; old commit SHAs will become invalid.
- Preserve all unrelated history.
- Keep the repository private until rewriting, release repair, release preparation, and auditing are complete.
- Prepare exactly version `1.1.0`. Do not create `v1.1.0`, create its GitHub Release, or publish `pdf-scrubber@1.1.0`.
- Do not make the repository public when a scan, authentication check, workflow, or readiness check fails or remains uncertain.

## History cleanup

Capture the original `main` and `v1.0.0` SHAs and the current v1.0.0 release metadata. Create an OpenCode-owned temporary recovery bundle outside the checkout before rewriting. Preserve the local `.opencode/` directory outside the rewrite and restore it only as ignored, untracked tooling.

Replace the current `.opencode` exception rules in `.gitignore` with one `.opencode/` rule. Retain `docs/` in `.gitignore`. Apply a path-targeted history rewrite that removes `.opencode/**` from every commit while preserving every unrelated path and commit. Verify the path is absent from all rewritten trees and reachable refs before updating GitHub.

Force-update only `main` and `v1.0.0`. Confirm both remote refs resolve to the expected rewritten SHAs. If either update fails or only one ref changes, keep the repository private and repair the ref state before proceeding. Remove the temporary recovery bundle only after remote verification and when rollback evidence is no longer required.

## Existing v1.0.0 release

Retargeting `v1.0.0` to the corresponding cleaned commit preserves the release source snapshot except for `.opencode` removal. Edit the existing GitHub Release rather than creating another release or attempting to republish the immutable npm version.

Use the Swoof release convention:

- title `PDF-Scrubber 1.0.0`;
- concise sections grouped by user-facing editing capability, privacy and safety, and internal verification;
- retain `npx pdf-scrubber@1.0.0` installation guidance;
- include a rewritten-history comparison link only if a valid baseline can be established.

Verify that the existing release URL works and that npm still reports `pdf-scrubber@1.0.0`. Editing release metadata must not trigger or claim a second npm publication.

## README and public-source accuracy

Remove the complete root `README.md` section beginning with `## Supported editing` and ending immediately before `## Checks`. Do not restructure unrelated README content.

Because the final repository will be public, replace the statements that GitHub source is private in both `README.md` and `apps/cli/README.md` with accurate public-source wording. Keep version-bearing badges and runnable pinned commands at the published stable version `1.0.0`; pointing public documentation at absent v1.1.0 Git and npm artefacts would be inaccurate.

## Version 1.1.0 preparation

Begin only after the rewritten `main` is clean, private, and synchronised with upstream. Prove that neither `v1.1.0` nor `pdf-scrubber@1.1.0` exists; lookup or authentication errors are blockers.

Update `apps/cli/package.json` and the root `package-lock.json` to exactly `1.1.0`. Update package-identity checks to the prepared version while retaining README badge, link, command, and stable-publication guard expectations at published version `1.0.0`. Run focused release-contract tests, package checks, and `npm run verify:release`. Stop on any failure.

Commit and push the intended documentation and release metadata normally. Require the repository tree and release SHA to remain unchanged and require a successful GitHub `Verify` workflow for that exact SHA. Draft complete Swoof-style 1.1.0 release notes for review, but do not create a tag or GitHub Release and do not publish npm.

## Sensitive-information audit

Audit the final rewritten state, not the pre-rewrite repository. The audit covers:

- every reachable rewritten commit with Gitleaks;
- tracked filenames and file contents for credentials, private keys, tokens, passwords, private paths, internal hostnames, and unintended personal data;
- commit author and committer metadata;
- GitHub workflows, permissions, release notes, release assets, repository metadata, remotes, submodules, and large-file pointers;
- the npm package contents and public-facing package metadata;
- licence presence and documentation claims;
- dependency and workflow risks that materially affect safe public exposure.

Secret values must never be printed in the report. Scanner errors, incomplete history coverage, or inaccessible GitHub state count as blockers. Benign public identity metadata, such as the package author's intended public name and email, may remain only when it is clearly intentional.

## Public-readiness gate

Change GitHub visibility only when all of these conditions hold:

1. `.opencode` is absent from all reachable remote history and tags.
2. The rewritten `main` and `v1.0.0` refs match the locally verified refs.
3. The v1.0.0 release is accurate and npm 1.0.0 remains available.
4. The 1.1.0 preparation commit passed local release gates and exact-SHA GitHub verification.
5. No material sensitive-information, licensing, packaging, workflow, or documentation blocker remains.
6. The working tree is clean and synchronised.

If every condition passes, change `DrTralala/PDF-Scrubber` to public visibility and verify the reported visibility plus anonymous access to the repository and v1.0.0 release. If any condition fails, leave the repository private and report the precise blocker.

## Validation and reporting

The final report distinguishes:

- original and rewritten SHAs for `main` and `v1.0.0`;
- `.gitignore` and README changes;
- v1.0.0 release title, notes, URL, and npm state;
- prepared-only 1.1.0 SHA, metadata changes, local gates, exact-SHA `Verify` result, and draft release-note preview;
- sensitive-information scan scope and results without exposing secret values;
- final GitHub visibility and anonymous-access checks;
- cleanup of the temporary recovery bundle and any remaining blocker or risk.

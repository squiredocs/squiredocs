# Promotion notes: 007-documentation-site

## Post-merge review dispositions (2026-07-14, review of ea8dd5f...2a6b0c4)

Review verdicts: trust/exposure CLEAN, app invariants CLEAN, correctness one HIGH, content accurate and terminology-clean, tests honest. All findings fixed same-day in the main tree.

| Finding | Severity | Disposition |
| --- | --- | --- |
| Desktop sidebar invisible: closed `<details>` cannot be revealed by author CSS; wide viewports showed an empty box | HIGH | FIXED: sidebar renders with the `open` attribute; a two-line inline script collapses it on viewports under 900px at load. CSS comment corrected. Verified in built output. |
| `/Documentation` (case variant) served the index in production but fell through to the app shell in dev | LOW | FIXED: router is now `caseSensitive: true`; the case variant falls through to the app shell in both environments (parity, matching the route contract). |
| 404 page declared a canonical/og:url pointing at a URL that 404s | LOW | FIXED: the 404 page now emits `noindex` and no canonical or og:url. |
| `validatePages` accepted the reserved slug `404`, letting the build silently overwrite an authored page | LOW | FIXED: slug `404` is rejected at validation with a named error. |
| Terminology build gate missed phrasings like "see the docs", "check the docs" | LOW | FIXED: patterns broadened (see/check/read/visit/consult/open + "in the docs" + "docs for/about/on"). Shipped content was already clean. |
| Three content overstatements (signed in "until you sign out"; every change "can be reversed"; link protocol allowlist attributed to export) | LOW | FIXED: reworded per review suggestions; claims now match `server/auth/jwt.js`, version-history restore semantics, and the import/agent-write enforcement boundary. |

## Owed at promotion / follow-ups

- Manual visual check by Sam: desktop sidebar on a real browser at >=900px, and the 375px narrow layout (T038 automated checks passed; the wide-viewport regression was only findable by eye, which is what let the HIGH through).
- Test-honesty gap (accepted): `build()`/`loadPages()`/`fail()` in `build-documentation.mjs` are exercised only by real builds, not CI unit tests. The merge queue runs a real build, so this is covered operationally.
- README's older "light media plate" phrasing predates the D19 mermaid dark-inversion amendment; align next time README is touched (G4: README narrows toward developer material).
- Sitemap.xml deliberately skipped (Sam, G2). Revisit if search traffic matters.
- Deploy 2026-07-14 surfaced a gap: nothing local exercises the Dockerfile (CI runs tests only, the merge queue runs `npm run build` on the working tree), so a build step that needs a new directory in the image only fails at deploy time. The `documentation/` COPY is fixed; consider a Docker build smoke check if this recurs.

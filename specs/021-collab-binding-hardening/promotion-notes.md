# Feature 021 — promotion notes

## Post-merge review dispositions (2026-07-18, Fable review of 130bb0a)

Verdict: MERGE STANDS — the data-integrity core (tracked-skip diff exclusion,
docChanged gate, kill-switch-off verbatim-stock) survived 10 adversarial probes
against the patched updateYFragment. But CRITICAL-1 made the feature INERT in
prod images. All four actionable findings fixed:

- **CRITICAL-1 (deploy-blocking) FIXED**: the Dockerfile ran `npm ci` (the
  patch-package postinstall) BEFORE copying client/patches/, so patch-package
  found zero patches, exited 0 (--error-on-fail only catches FAILED
  applications, not absent ones), and the image shipped STOCK y-tiptap with the
  delete-on-catch bug — while the admin UI reported hardening ON. Fixed: copy
  client/patches/ before npm ci + an in-image `grep -q SQUIRE-021:` assertion
  on both dist files that fails the build if the patch didn't apply.
- **MEDIUM-2 FIXED**: the kill-switch cache is write-through per-pod, so a flip
  wouldn't reach other replicas until restart (same non-sticky-routing gap 015
  addressed). /api/client-config now reads fresh from the DB at bootstrap
  (getCollabBindingHardeningFresh — one cheap SELECT, off the render hot path),
  falling back to cache on error. Cross-replica regression test added.
- **MEDIUM-3 FIXED**: the skip beacon reported ydoc.guid, but useYjs created
  `new Y.Doc()` with a random per-tab UUID — so reports named no real document.
  useYjs now creates `new Y.Doc({ guid: docGuid })` (IndexeddbPersistence keys
  off the separate string arg — no side effect).
- **LOW-4 FIXED**: skipReporter.js had a literal NUL byte in its aggregation
  key, making git treat the file as binary (unreviewable). Replaced with '|'.
- **LOW-5 NOTED**: the guardrail's synchronous Y.decodeUpdate prefix briefly
  runs in the persistence .then chain for large pastes (latency, not
  correctness); setImmediate it if it ever matters.

## Owed follow-ups
- Upstream filing (y-tiptap issue + y-prosemirror #39/#258 comment with the
  repro — the maintainer is active in this exact area).
- Post-deploy: kill-switch flip drill against a running 2-replica cluster;
  browser two-tab sync drill; quarantine on a real unknown-node doc.
- Track the y-prosemirror v2 rewrite (no catch-delete, docChanged-gated diff)
  as the eventual exit ramp from the fork.

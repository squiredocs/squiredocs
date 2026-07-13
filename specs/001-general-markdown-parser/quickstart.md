# Quickstart — Validating 001-general-markdown-parser

Runnable scenarios proving the feature end-to-end. All commands run inside the Minikube `app-dev` pod at the repo root (see `docs/dev.md`). Backend tests MUST run serially (they share one DB; the new parser suites are DB-free but ride the same Jest run).

## Prerequisites

- Repo checked out (worktree fine), `npm install` done at root and in `client/` (adds the `fast-check` devDependency).
- No services needed for the parser suites themselves; the full backend suite needs the usual pg/redis (already wired in the dev pod).

## 1. Strict mode is byte-identical (US3 / CN-2 / SC-004)

```bash
npx jest server/__tests__/markdown-strict-characterization.test.js --runInBand --silent
npx jest server/__tests__/diff-service.test.js --runInBand --silent
```

**Expected**: both green. The characterization suite deep-equals strict-mode output against `server/__tests__/fixtures/markdown/strict-characterization.json` (generated from the pre-move parser); the diff-service suite passes without modification to its assertions.

## 2. Tolerant grammar conformance (US1 / SC-001 / SC-002)

```bash
npx jest server/__tests__/markdown-tolerant.test.js server/__tests__/markdown-fixtures.test.js --runInBand --silent
```

**Expected**: green; 100% of curated CommonMark/GFM fixtures pass; every excluded example appears in `server/__tests__/fixtures/markdown/EXCLUSIONS.md` with a reason; all ≥10 real-world docs match their structural expectations with zero false literal-text degradations.

Spot-check by hand:

```bash
node -e "const {markdownToPm}=require('./shared/markdown'); console.log(JSON.stringify(markdownToPm('Title\n===\n\n- [x] done\n\n*em* and __strong__'),null,2))"
```

**Expected**: `heading{level:1}`, a `bulletList` whose item text starts with `[x] `, and `italic`/`bold` marks.

## 3. Never-lose-content + performance (US2 / SC-003 / SC-006)

```bash
npx jest server/__tests__/markdown-fuzz.test.js --runInBand --silent
```

**Expected**: green across thousands of generated inputs (fixed seed): no throws, schema-valid docs, word-subsequence preservation, 100 KB doc < 1 s, no 64 KB case > 5 s.

## 4. Round-trip in both modes (FR-016 / SC-005)

```bash
npx jest server/__tests__/format-roundtrip.test.js --runInBand --silent
```

**Expected**: green; every registry mark, style prop, and block type round-trips through `toMarkdown` → `markdownToPm` in **both** strict and tolerant modes.

## 5. Client-safety (US4 / SC-007)

```bash
cd client && npx vitest run src/__tests__/sharedMarkdown.test.js
```

**Expected**: green — shared parser + registry import under the client toolchain (jsdom), parse a sample correctly, and the module-graph scan finds no Node built-in requires.

## 6. Full gate (Constitution II — before commit)

```bash
npm run test:server   # serial Jest, LLM reporter
npm run test:client   # Vitest
```

**Expected**: all suites green with no assertion changes outside this feature's files. Also verify: `server/markdown-to-pm.js` and `server/format-registry.js` no longer exist (`git status` shows them deleted); `grep -rn "require.*markdown-to-pm\|require.*server/format-registry" server/ client/src/` finds nothing.

## Reference

- API contract: [contracts/parser-api.md](./contracts/parser-api.md)
- Grammar/degradation tables: [data-model.md](./data-model.md)
- Decision log: [research.md](./research.md), [clarifications-needed.md](./clarifications-needed.md)

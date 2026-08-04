# Clarifications Ledger: 051-ci-parallel-jobs

Decisions taken at their best default under the parallel-pipeline rule and recorded here as
RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04). Umbrella decisions D1–D4 in
`design/test-suite-architecture.md` were already ratified at their stated defaults on
2026-08-04 and are NOT re-opened here; D2 (perf guards stay in the default run) is restated
in the spec's Out of Scope purely as a scope boundary.

---

## CN-051-01 — Jest cache directory path — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)

**Question**: The design (§1.3) requires a "repo-local Jest `cacheDirectory`" but names no
path. Where does it live?

**Why it matters**: The path appears in three places that must agree (jest config,
actions/cache step, .gitignore), and a bad choice (e.g. inside `tmp/`, which deploy scripts
and scratch cleanup already treat as disposable, or a non-hidden dir) would pollute the tree
or get clobbered.

**Default taken**: A dot-directory at the repo root, `.jest-cache/`, with a matching
`.gitignore` entry.

**Rationale**: Conventional, self-describing, hidden from casual listings, outside every
existing glob (`tmp/`, `coverage/`, worktree ignore patterns), and trivially referenced as
`<rootDir>/.jest-cache` in the jest config and as a literal path in the workflow cache step.

---

## CN-051-02 — actions/cache key composition and fallback — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)

**Question**: The design says the cache is "keyed on package-lock.json". Exact key: root
lockfile only, or both lockfiles? OS/node in the key? Is a `restore-keys` prefix fallback
allowed?

**Why it matters**: Too-narrow a key (e.g. including the commit SHA) means a permanently
cold cache; too-loose risks unbounded staleness; the client lockfile is irrelevant to the
backend Jest transform cache and would cause pointless misses.

**Default taken**: Primary key = runner OS + hash of the root `package-lock.json`
(e.g. `jest-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`), plus a
`restore-keys` prefix fallback (`jest-cache-${{ runner.os }}-`) so a lockfile bump still
restores the previous cache as a warm start.

**Rationale**: Jest's cache is self-invalidating per entry (it re-transforms on content
mismatch), so a stale restore is a speed optimization, never a correctness risk — the design
itself frames the cache as pure repeated-work elimination, and spec FR-007 pins
correctness-neutrality. The client lockfile is excluded because client deps never enter the
backend transform path.

---

## CN-051-03 — Per-job dependency installs — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)

**Question**: The design notes the current job "runs `npm ci` twice" (root, then client) but
is silent on which installs each of the two new jobs needs.

**Why it matters**: Installing both trees in both jobs wastes the parallelism the feature
exists to buy; installing too little breaks a suite (the first-run rehearsal and both LLM
reporters live at the repo root; Vitest runs from `client/`).

**Default taken**: Backend job runs root `npm ci` only. Client job runs root `npm ci` and
`cd client && npm ci`.

**Rationale**: `test:server` (Jest) resolves entirely from root `node_modules`;
`test:client` needs `client/node_modules` and the root-level reporter script;
`test:first-run` (`node --test test/first-run/*.test.mjs`) imports repo modules such as
`distribution/publish.mjs`, so the safe default keeps the root install in the client job
rather than assuming the rehearsal suite touches no root dependency. The plan phase may
verify and slim this, but must not go below this floor without proof.

---

## CN-051-04 — README CI-note wording — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)

**Question**: T019 requires re-reading the CI note at `README.md:243` and correcting it if the
split falsified it. The note said CI "only runs the server and client tests". How much should
change?

**Default taken**: Reworded in place, no restructuring:

> CI (`.github/workflows/test.yml`) only runs tests — a `backend` job for the server suite and
> a `client` job for the client and first-run rehearsal suites, the two running in parallel. It
> does **not** build or push any image.

**Rationale**: The sentence's load-bearing claim (CI builds no image, so a prod deploy needs a
local build+push) is untouched by this feature and stays word-for-word. Two accuracy problems
are fixed in one edit: the pre-existing omission of the first-run rehearsal suite, which T019
explicitly puts in bounds, and the now-stale implication of a single sequential job. Naming the
job names is what makes a red run readable against the README. Constitution Principle I is the
authority here; a documentation file is not an application source file under FR-009.

---

## CN-051-05 — Cache step position within the backend job — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)

**Question**: T011 places `actions/cache@v4` "after `Set up Node.js` and before the
`Run server tests` step" — a window that contains the `Install dependencies` step, so two slots
qualify.

**Default taken**: Immediately after `Set up Node.js`, before `Install dependencies`.

**Rationale**: Matches the task's first-named anchor literally, and groups the two cache
restores (npm tarballs, then Jest transform output) adjacently so a reader sees the caching
strategy in one place. Functionally equivalent to the later slot: `npm ci` only removes
`node_modules` and never touches `.jest-cache`.

---

## Flagged gaps (informational, no decision required)

- **G-051-A — Wall-time target is train-order dependent**: the design's "~180s, jobs in
  parallel" Expected Outcome assumes Train A (050) has landed when measured against the
  post-050 backend time, but Trains A and B are declared independent. SC-001 states both
  numbers explicitly; verification should measure against whichever backend baseline is
  current at merge time, not the table's single figure.
- **G-051-B — Design's "npm ci twice" observation**: §1.3 mentions the double install as
  part of the current-state cost but prescribes no change to install strategy beyond the
  caches. This spec keeps `npm ci` per job (CN-051-03) and adds no install restructuring;
  if further install-time work is wanted it needs a design amendment, not scope creep here.

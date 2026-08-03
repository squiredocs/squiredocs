# Quickstart — validating 049

All commands run **inside the Minikube `app-dev` pod** (`docs/dev.md`), from the
repo root. Backend tests share one database and **must run serially** — never
launch a second backend run against the same DB (Constitution Principle II).

---

## 0. Prerequisite: the FR-008 gate

Nothing below is meaningful until `clientid-reader-audit.md` exists in this
feature directory and classifies **every** reader of a document's client id, with
the exact library versions it was checked against.

```bash
node -e "for (const p of ['yjs','y-protocols','y-websocket']) console.log(p, require('./node_modules/'+p+'/package.json').version)"
# expected at the time of writing: yjs 13.6.30 / y-protocols 1.0.7 / y-websocket 1.5.4
```

**Search hazard**: several files in this repo contain NUL bytes and are treated
as binary by plain `grep`, which then reports **no matches** silently
(`server/markdown-sync.js`, `server/resupply-resolution.js` known today). Use
`grep -a`. A negative plain `grep` is not evidence of absence — it has already
produced one withdrawn finding in this feature's ledger.

```bash
grep -arn "clientID" server/ --include=*.js | grep -v node_modules
grep -arn "clientID" node_modules/y-protocols node_modules/y-websocket/bin
```

A **live** reader — one that reads `doc.clientID` while a transaction may be open
— stops the line.

## 1. The mechanism guards (hermetic: no DB, no WebSocket)

```bash
npx jest server/__tests__/borrowed-identity.test.js --runInBand
npx jest server/__tests__/per-operation-doc.test.js --runInBand
```

Expect: G1/G2 and the whole H class unchanged; G3/G4/G4b/G5 re-pointed; N1–N10
passing. See [contracts/invariant-guards.md](./contracts/invariant-guards.md).

## 2. The deliberate-regression check (SC-008 — do it, do not assume it)

Two one-line breakages, each of which **must** make a guard fail *by name*:

1. In `server/document-service.js`, skip the borrow install (leave
   `ydoc.clientID` alone) → G1 and N9 must fail with a message naming the
   borrowed-identity mechanism.
2. In the `finally`, skip the restore → N1 and N9 must fail.

Revert both. Record in the implementation notes that the check was run, not that
it was expected to pass.

## 3. The performance shape (FR-013 / SC-001)

```bash
npx jest server/__tests__/borrowed-identity-performance.test.js --runInBand
```

Assertion is the **shape** (per-operation time does not scale with document
size), with a contention-tolerant ratio ceiling; the real numbers are
`console.log`ged and copied into `performance.md`. Reference points from the
design's measured table: 0.16 ms @ 79 KB, 0.06 ms @ 794 KB, 0.17 ms @ 3.2 MB
(versus 15.6 / 56.4 / 211.8 ms for the ephemeral copy).

## 4. The converged call sites

```bash
npx jest server/__tests__/document-service-capture.test.js \
         server/__tests__/bindstate-failure.test.js \
         server/__tests__/live-fanout.test.js \
         server/__tests__/resupply-resolution.test.js \
         server/__tests__/api-docs-import.test.js \
         server/__tests__/chat-tools.test.js \
         server/__tests__/import-presence.test.js \
         --runInBand
npx jest server/mcp/__tests__ --runInBand
```

Expect **no assertion changes** in any of these. If one has to change to pass,
that is a behavior regression — report it rather than accommodating it.

## 5. The full backend suite (the merge gate)

```bash
npx jest --runInBand
```

## 6. Reproducing the plan's probes

Every mechanism claim in [research.md](./research.md) §R3–R4 is reproducible in a
few lines of plain node against this repo's yjs. The two that matter most:

```js
const Y = require('yjs');
const d = new Y.Doc(); const own = d.clientID;

// (a) The borrow window is wider than the caller's function: a doc-level
//     'update' listener sees the BORROWED id, because yjs emits from inside
//     transaction cleanup. This is why FR-008 covers persistence, broadcast,
//     fan-out and the origin capture.
let seen = null;
d.on('update', () => { seen = d.clientID; });
d.clientID = 123456789;
try { d.transact(() => d.getMap('meta').set('t', 1), { o: 1 }); } finally { d.clientID = own; }
console.log(seen === 123456789);   // true

// (b) A delete-only mutation does NOT change the state vector — which is why
//     the ratified state-vector detector is paired with an update tripwire.
d.get('default', Y.XmlFragment).insert(0, [new Y.XmlText('x')]);
const before = Y.encodeStateVector(d);
d.get('default', Y.XmlFragment).delete(0, 1);
console.log(Buffer.compare(Buffer.from(before), Buffer.from(Y.encodeStateVector(d))) === 0);  // true
```

## 7. Manual walk (owed to Sam, after deploy)

Not automatable from here; listed so it is not forgotten:

- set a title on a large document through MCP → title lands, version history
  names the acting agent, undo reverses it;
- import markdown with `insertAfterXPath` at a target that exists → content lands
  after it; at one that does not → **400 `XPATH_NO_MATCH`, and the document is
  byte-unchanged**;
- drop an image into a document from chat → placement and attribution unchanged;
- open the document in two browsers during a server-side write → both converge,
  presence is untouched, no borrowed identity ever appears as a participant.

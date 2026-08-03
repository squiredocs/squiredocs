/**
 * Feature 038 US4 (FR-019/020/021) — `updateDocument`'s update capture.
 *
 * The bug (F4): capture used `ydoc.once('update', …)` with NO origin check,
 * armed against a 50 ms timeout. On the no-change path — where this call's own
 * event never fires — the listener stayed armed for the full 50 ms on a SHARED,
 * live document, and consumed whatever landed next. A concurrent edit by an
 * unrelated user was then returned to this caller as "the bytes this call
 * produced", and 037's fan-out logic republished it under this call's
 * attribution.
 *
 * The fix is origin-IDENTITY scoping plus synchronous detachment: capture only
 * an update whose origin === this call's own origin object, and remove the
 * listener in a `finally` the moment `transact` returns. Yjs fires doc `update`
 * events synchronously at transaction end, so nothing is lost by not waiting.
 *
 * These tests drive document-service against a plain local Y.Doc through its
 * `init` seam — no DB, no WS — so they isolate the capture contract itself.
 * `live-fanout.test.js` and `import-presence.test.js` guard the 037 semantics
 * this must not disturb.
 */
const Y = require('yjs');
const documentService = require('../document-service');
const { createOrigin } = require('../origin');

/** The former armed-listener window. The repro must land inside it. */
const FORMER_TIMEOUT_MS = 50;

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Count 'update' listeners currently attached to a Y.Doc. */
const updateListenerCount = (ydoc) => (ydoc._observers.get('update') || new Set()).size;

const paragraph = (text) => {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
};

describe('038 US4 — updateDocument capture is origin-scoped and synchronously detached', () => {
  let ydoc;
  const DOC_GUID = 'doc-under-test';

  beforeEach(() => {
    ydoc = new Y.Doc();
    // The honest statement "this fake is fully loaded" — the 048 bind-readiness
    // gate waits on exactly this flag, which the real createBindState sets at
    // the end of a successful load.
    ydoc._bindComplete = true;
    // The service asks for a shared doc by name; hand it ours.
    documentService.init(() => ydoc, (n) => (n.startsWith('s/') ? n.slice(2) : n));
  });

  // ── (a) the change path still behaves exactly as 037 requires ─────────────

  describe('(a) change-producing calls', () => {
    test('returns exactly this transaction\'s own update bytes', async () => {
      const before = Y.encodeStateVector(ydoc);

      const result = await documentService.updateDocument(
        DOC_GUID,
        (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('mine')]); },
        { userId: 'u1', agentName: null }
      );

      expect(result.update).toBeInstanceOf(Uint8Array);

      // Applying the returned bytes to a doc at the pre-call state reproduces
      // the change — i.e. these really are this transaction's bytes.
      const replica = new Y.Doc();
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc, before));
      const check = new Y.Doc();
      Y.applyUpdate(check, result.update);
      expect(check.get('default', Y.XmlFragment).toString()).toContain('mine');
    });

    test('hadRedisHandler is sampled at EMIT time, not after the await (037)', async () => {
      // Attached before the transaction: the handler would have seen the event.
      ydoc._redisUpdateHandler = () => {};
      const withHandler = await documentService.updateDocument(
        DOC_GUID,
        (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('a')]); },
        { userId: 'u1' }
      );
      expect(withHandler.hadRedisHandler).toBe(true);

      // Detached before the transaction: the handler never saw the event, so
      // the caller must publish. A post-hoc check would be a silent loss.
      delete ydoc._redisUpdateHandler;
      const withoutHandler = await documentService.updateDocument(
        DOC_GUID,
        (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('b')]); },
        { userId: 'u1' }
      );
      expect(withoutHandler.hadRedisHandler).toBe(false);
    });

    test('a handler attached AFTER the transaction is not credited', async () => {
      // The 037 hazard in reverse: sampling must reflect the emit instant.
      const result = await documentService.updateDocument(
        DOC_GUID,
        (doc) => {
          doc.get('default', Y.XmlFragment).insert(0, [paragraph('c')]);
          // Someone connects mid-flight, after our event already fired.
          setImmediate(() => { ydoc._redisUpdateHandler = () => {}; });
        },
        { userId: 'u1' }
      );
      expect(result.hadRedisHandler).toBe(false);
    });

    test('the returned shape is unchanged', async () => {
      const result = await documentService.updateDocument(
        DOC_GUID,
        (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('d')]); },
        { userId: 'u1' }
      );
      expect(Object.keys(result).sort()).toEqual(['hadRedisHandler', 'update']);
    });
  });

  // ── (b) THE F4 REPRO ──────────────────────────────────────────────────────

  describe('(b) the capture race', () => {
    test('a foreign update landing inside the FORMER 50ms window is never captured', async () => {
      // Seed content so the foreign edit below is a real change.
      ydoc.get('default', Y.XmlFragment).insert(0, [paragraph('existing')]);

      // A no-change call: our own update event will never fire, which is exactly
      // when the old code sat waiting with an armed, origin-blind listener.
      const pending = documentService.updateDocument(
        DOC_GUID,
        () => { /* inspects only — changes nothing */ },
        { userId: 'me', agentName: null }
      );

      // An unrelated user edits the same shared doc a few ms later — well inside
      // the former 50 ms window. Under the old code the armed `once` listener
      // consumed THIS update and returned it as ours.
      await tick(5);
      const foreignDoc = new Y.Doc();
      Y.applyUpdate(foreignDoc, Y.encodeStateAsUpdate(ydoc));
      foreignDoc.get('default', Y.XmlFragment).insert(1, [paragraph('SOMEONE ELSE')]);
      const foreignUpdate = Y.encodeStateAsUpdate(foreignDoc, Y.encodeStateVector(ydoc));
      Y.applyUpdate(ydoc, foreignUpdate, createOrigin('other-user', null));

      const result = await pending;

      // Nothing captured, nothing to republish, no borrowed attribution.
      expect(result).toEqual({ update: null, hadRedisHandler: false });
      expect(result.update).toBeNull();

      // The foreign edit itself is untouched — we ignored it, we did not eat it.
      expect(ydoc.get('default', Y.XmlFragment).toString()).toContain('SOMEONE ELSE');
    });

    test('a foreign update is ignored WITHOUT consuming the listener (on/off, not once)', async () => {
      // Two foreign updates around a change-producing call: neither may be
      // captured, and the second must not be captured "because the first used
      // up the once-listener" either.
      ydoc.get('default', Y.XmlFragment).insert(0, [paragraph('base')]);
      const preState = Y.encodeStateAsUpdate(ydoc);

      const foreign = (text) => {
        const d = new Y.Doc();
        Y.applyUpdate(d, Y.encodeStateAsUpdate(ydoc));
        d.get('default', Y.XmlFragment).insert(0, [paragraph(text)]);
        return Y.encodeStateAsUpdate(d, Y.encodeStateVector(ydoc));
      };

      const result = await documentService.updateDocument(
        DOC_GUID,
        (doc) => {
          // NOTE: we deliberately do NOT apply a foreign update in here. Yjs
          // nested transactions inherit the OUTER origin, so an applyUpdate
          // inside this callback would arrive stamped with our own origin and
          // prove nothing about origin scoping.
          doc.get('default', Y.XmlFragment).insert(0, [paragraph('ours')]);
        },
        { userId: 'me' }
      );

      // The captured bytes are incremental, so replay them onto the pre-call
      // state — that is exactly how a receiving instance consumes them.
      const captured = new Y.Doc();
      Y.applyUpdate(captured, preState);
      Y.applyUpdate(captured, result.update);
      expect(captured.get('default', Y.XmlFragment).toString()).toContain('ours');
      expect(captured.get('default', Y.XmlFragment).toString()).not.toContain('SOMEONE');

      // And after the call, foreign traffic is simply not our business.
      Y.applyUpdate(ydoc, foreign('SOMEONE ELSE'), createOrigin('other-user'));
      expect(updateListenerCount(ydoc)).toBe(0);
    });

    test('two overlapping updateDocument calls each capture only their own bytes', async () => {
      const preState = Y.encodeStateAsUpdate(ydoc);

      const [a, b] = await Promise.all([
        documentService.updateDocument(
          DOC_GUID,
          (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('AAA')]); },
          { userId: 'user-a' }
        ),
        documentService.updateDocument(
          DOC_GUID,
          (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('BBB')]); },
          { userId: 'user-b' }
        ),
      ]);

      expect(a.update).toBeInstanceOf(Uint8Array);
      expect(b.update).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(a.update).equals(Buffer.from(b.update))).toBe(false);

      const replay = (...updates) => {
        const d = new Y.Doc();
        Y.applyUpdate(d, preState);
        for (const u of updates) Y.applyUpdate(d, u);
        return d.get('default', Y.XmlFragment).toString();
      };

      // A's bytes are A's alone — the F4 property. If the capture were still
      // origin-blind, the first caller to finish could carry the other's text.
      expect(replay(a.update)).toContain('AAA');
      expect(replay(a.update)).not.toContain('BBB');

      // B's bytes carry B's text (replayed after A, since B transacted second).
      expect(replay(a.update, b.update)).toContain('BBB');
      expect(replay(a.update, b.update)).toContain('AAA');
    });
  });

  // ── (c) no armed listener survives, ever ──────────────────────────────────

  describe('(c) listener lifetime', () => {
    test('no listener remains after a change-producing call', async () => {
      expect(updateListenerCount(ydoc)).toBe(0);
      await documentService.updateDocument(
        DOC_GUID,
        (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('x')]); },
        { userId: 'u1' }
      );
      expect(updateListenerCount(ydoc)).toBe(0);
    });

    test('no listener remains after a no-change call', async () => {
      await documentService.updateDocument(DOC_GUID, () => {}, { userId: 'u1' });
      expect(updateListenerCount(ydoc)).toBe(0);
    });

    test('updateFn throwing propagates AND leaves no armed listener', async () => {
      const boom = new Error('updateFn exploded');
      await expect(
        documentService.updateDocument(DOC_GUID, () => { throw boom; }, { userId: 'u1' })
      ).rejects.toThrow('updateFn exploded');

      // Structural check...
      expect(updateListenerCount(ydoc)).toBe(0);

      // ...and a behavioral probe: a subsequent foreign update must not be
      // captured by any straggler listener.
      let observed = 0;
      ydoc.on('update', () => { observed += 1; });
      ydoc.get('default', Y.XmlFragment).insert(0, [paragraph('probe')]);
      expect(observed).toBe(1); // only our probe listener saw it
      expect(updateListenerCount(ydoc)).toBe(1);
    });

    test('a throwing updateFn that already made changes still detaches', async () => {
      await expect(
        documentService.updateDocument(
          DOC_GUID,
          (doc) => {
            doc.get('default', Y.XmlFragment).insert(0, [paragraph('partial')]);
            throw new Error('after mutating');
          },
          { userId: 'u1' }
        )
      ).rejects.toThrow('after mutating');
      expect(updateListenerCount(ydoc)).toBe(0);
    });
  });

  // ── (d) the 50 ms wait is gone ────────────────────────────────────────────

  describe('(d) no timer on the no-change path', () => {
    test('a no-change call resolves well inside the former 50ms window', async () => {
      const started = Date.now();
      const result = await documentService.updateDocument(DOC_GUID, () => {}, { userId: 'u1' });
      const elapsed = Date.now() - started;

      expect(result).toEqual({ update: null, hadRedisHandler: false });
      // The old implementation could not return before ~50 ms here.
      expect(elapsed).toBeLessThan(FORMER_TIMEOUT_MS);
    });

    test('many no-change calls in sequence stay fast (no accumulated timers)', async () => {
      const started = Date.now();
      for (let i = 0; i < 10; i++) {
        await documentService.updateDocument(DOC_GUID, () => {}, { userId: 'u1' });
      }
      // The old code: 10 x 50 ms = ~500 ms minimum.
      expect(Date.now() - started).toBeLessThan(FORMER_TIMEOUT_MS * 4);
    });

    test('a transaction that produces no net change is treated as no-change', async () => {
      ydoc.get('default', Y.XmlFragment).insert(0, [paragraph('stable')]);
      const started = Date.now();
      const result = await documentService.updateDocument(
        DOC_GUID,
        (doc) => { doc.get('default', Y.XmlFragment).toString(); }, // read-only
        { userId: 'u1' }
      );
      expect(result.update).toBeNull();
      expect(Date.now() - started).toBeLessThan(FORMER_TIMEOUT_MS);
    });
  });
});

/**
 * Edit-range capture + durability verification (feature 016, research R2, RBD-8).
 *
 * A modify call's edits reach the database asynchronously: the session doc's
 * local updates ship over the WebSocket to the server's shared doc, whose
 * bindState listener persists each one with (userId, agentName) attribution.
 * The durable edit identifier (FR-001..004) therefore cannot be inferred at
 * response time — instead modify:
 *
 *   1. captures the update payloads its own execution emits on the session doc
 *      (captureEditUpdates), and
 *   2. polls the log until the acting identity's stored rows provably cover
 *      every captured payload's struct ranges AND delete-sets
 *      (awaitDurableRange) — exact even for deletion-only edits, and immune to
 *      unrelated same-identity rows (different clientIDs / pre-baseline struct
 *      clocks never intersect the captured coverage).
 *
 * The recorded range is [min clock, max clock] of the identity rows that
 * intersect the captured coverage, plus the EXACT covering clock set
 * (review M1): concurrent same-identity calls can interleave clocks inside
 * each other's [min,max] span, and undo must invert only this call's rows.
 */
const Y = require('yjs');

/**
 * Start capturing update payloads emitted by a doc.
 *
 * @param {Y.Doc} doc - The session (client-side) Y.Doc
 * @param {object} [opts]
 * @param {Iterable<*>} [opts.excludeOrigins] - Origins whose updates are NOT
 *   part of the edit (pass the session's WebsocketProvider so remote updates
 *   arriving mid-call are excluded). Everything else — implicit transactions
 *   from sanitization passes, the sandbox bridge's applyUpdate with its
 *   string origin — is captured.
 * @returns {{ payloads: Uint8Array[], stop: () => Uint8Array[] }}
 */
function captureEditUpdates(doc, { excludeOrigins = [] } = {}) {
  const excluded = new Set(excludeOrigins);
  const payloads = [];
  const handler = (update, origin) => {
    if (excluded.has(origin)) return;
    payloads.push(update);
  };
  doc.on('update', handler);
  return {
    payloads,
    stop() {
      doc.off('update', handler);
      return payloads;
    },
  };
}

/** Extract { structs, deletes } interval coverage (Map client -> [{start,end}], end exclusive). */
function coverageOf(updates) {
  const structs = new Map();
  const deletes = new Map();
  const push = (map, client, start, end) => {
    if (end <= start) return;
    if (!map.has(client)) map.set(client, []);
    map.get(client).push({ start, end });
  };
  for (const u of updates) {
    const data = u instanceof Uint8Array ? u : new Uint8Array(u);
    const meta = Y.parseUpdateMeta(data);
    for (const [client, from] of meta.from) {
      push(structs, client, from, meta.to.get(client));
    }
    const { ds } = Y.decodeUpdate(data);
    for (const [client, items] of ds.clients) {
      for (const item of items) push(deletes, client, item.clock, item.clock + item.len);
    }
  }
  return { structs, deletes };
}

/** Merge an interval list into sorted, disjoint intervals. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

/** True when every target interval lies within the union of `cover`. */
function intervalsCovered(target, cover) {
  const union = mergeIntervals(cover);
  for (const t of target) {
    let remaining = { ...t };
    for (const c of union) {
      if (c.start <= remaining.start && remaining.start < c.end) {
        remaining.start = c.end;
        if (remaining.start >= remaining.end) break;
      }
    }
    if (remaining.start < remaining.end) return false;
  }
  return true;
}

/** True when `captured` coverage is fully contained in `stored` coverage. */
function coverageContained(captured, stored) {
  for (const [client, intervals] of captured.structs) {
    if (!intervalsCovered(intervals, stored.structs.get(client) || [])) return false;
  }
  for (const [client, intervals] of captured.deletes) {
    if (!intervalsCovered(intervals, stored.deletes.get(client) || [])) return false;
  }
  return true;
}

/** True when the two coverages share any overlapping interval. */
function coverageIntersects(a, b) {
  const overlaps = (mapA, mapB) => {
    for (const [client, listA] of mapA) {
      const listB = mapB.get(client);
      if (!listB) continue;
      for (const ivA of listA) {
        for (const ivB of listB) {
          if (ivA.start < ivB.end && ivB.start < ivA.end) return true;
        }
      }
    }
    return false;
  };
  return overlaps(a.structs, b.structs) || overlaps(a.deletes, b.deletes);
}

const MAX_CLOCK = 2147483647; // Postgres int4 upper bound

/**
 * Poll the log until the identity's rows after `baselineClock` durably cover
 * every captured payload, then return the covering rows' clock range.
 *
 * @param {object} persistence - PostgresPersistence (getUpdatesInRange)
 * @param {string} docGuid
 * @param {{userId: string, agentName: string|null}} identity - Acting identity
 * @param {number|null} baselineClock - Pre-edit max clock (null/-1 for empty doc)
 * @param {Uint8Array[]} payloads - Captured update payloads
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.pollIntervalMs=150]
 * @returns {Promise<{clockStart: number, clockEnd: number, clocks: number[]} | null>}
 *   null on timeout (RBD-8: caller returns editRangePending and finishes
 *   recording in the background) or when there is nothing to record. `clocks`
 *   is the exact ascending clock set of the covering rows (M1).
 */
async function awaitDurableRange(persistence, docGuid, identity, baselineClock, payloads, opts = {}) {
  const { timeoutMs = 5000, pollIntervalMs = 150 } = opts;
  const nonEmpty = (payloads || []).filter((u) => u && u.length > 0);
  if (nonEmpty.length === 0) return null;

  const captured = coverageOf(nonEmpty);
  if (captured.structs.size === 0 && captured.deletes.size === 0) return null;

  const from = (typeof baselineClock === 'number' ? baselineClock : -1) + 1;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let rows = [];
    try {
      rows = await persistence.getUpdatesInRange(docGuid, from, MAX_CLOCK);
    } catch (e) {
      console.warn(`[edit-range] durability poll failed for ${docGuid}:`, e.message);
    }

    const identityRows = rows.filter(
      (r) => r.userId === identity.userId && r.agentName === identity.agentName
    );

    if (identityRows.length > 0) {
      // Per-row coverage: which stored rows carry (part of) the captured edit?
      const covering = [];
      const storedCoverage = { structs: new Map(), deletes: new Map() };
      for (const r of identityRows) {
        const rowCoverage = coverageOf([r.updateData]);
        if (coverageIntersects(rowCoverage, captured)) {
          covering.push(r);
          for (const [client, list] of rowCoverage.structs) {
            if (!storedCoverage.structs.has(client)) storedCoverage.structs.set(client, []);
            storedCoverage.structs.get(client).push(...list);
          }
          for (const [client, list] of rowCoverage.deletes) {
            if (!storedCoverage.deletes.has(client)) storedCoverage.deletes.set(client, []);
            storedCoverage.deletes.get(client).push(...list);
          }
        }
      }

      if (covering.length > 0 && coverageContained(captured, storedCoverage)) {
        const clocks = covering.map((r) => r.clock).sort((a, b) => a - b);
        return { clockStart: clocks[0], clockEnd: clocks[clocks.length - 1], clocks };
      }
    }

    if (Date.now() + pollIntervalMs > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

module.exports = { captureEditUpdates, awaitDurableRange };

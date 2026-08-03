/**
 * Feature 047, NF-1 — the socket must not open ahead of IndexedDB.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 * `IndexeddbPersistence` and `WebsocketProvider` used to start with no ordering
 * between them. When a pod died in the publish-before-commit window, user U's
 * browser could hold content authored by V that the server never committed. If
 * WS sync finished BEFORE the IndexedDB read, y-indexeddb applied the cached
 * state into an already-synced doc; those server-missing structs were newly
 * integrated and fired a normal `update` whose origin is the IDB provider.
 * y-websocket relays every update whose origin is not itself, so V's content
 * left as an ordinary SYNC_UPDATE frame instead of a SYNC_STEP2 frame. The
 * durable row was stamped (U, null) with `via_sync` NULL, so every surface
 * confidently credited U for V's words — and that row then became admissible
 * evidence binding V's client identity to U, corrupting later resolutions too.
 *
 * The gate makes the cached state part of U's handshake state vector instead,
 * so it comes back through the channel feature 045 knows to distrust.
 *
 * The tests below assert ORDER, and the two failure modes a gate can introduce:
 * it must not deadlock when IndexedDB never reports, and it must not charge a
 * browser with no IndexedDB at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useYjs } from '../useYjs';
import { resetYjsSingletons, TEST_ACCESS_TOKEN } from '../../test/utils';

vi.mock('y-websocket');
vi.mock('y-indexeddb');

let docSeq = 0;
/** A fresh guid per test: the hook's doc cache is keyed by guid and lives across
 *  mounts by design, so reusing one would answer from an already-open gate. */
const nextGuid = () => `12345678-1234-4123-8123-${String(++docSeq).padStart(12, '0')}`;

describe('useYjs IndexedDB connect gate (NF-1)', () => {
  let mockProvider;

  const makeProvider = () => ({
    doc: new Y.Doc(),
    awareness: {
      getLocalState: vi.fn(() => ({})),
      getStates: vi.fn(() => new Map()),
      on: vi.fn(),
      off: vi.fn(),
      setLocalStateField: vi.fn(),
    },
    shouldConnect: false,
    synced: false,
    wsconnected: false,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    // Mirror y-websocket's flag semantics (see createControllableMockProvider):
    // an inert disconnect() is what masked the dead forceReconnect path.
    destroy: vi.fn(function () { this.shouldConnect = false; }),
    disconnect: vi.fn(function () { this.shouldConnect = false; }),
    connect: vi.fn(function () { this.shouldConnect = true; }),
  });

  beforeEach(() => {
    resetYjsSingletons();
    vi.clearAllMocks();
    mockProvider = makeProvider();
    WebsocketProvider.mockImplementation(() => mockProvider);
    // jsdom ships no IndexedDB, and `getOrCreateDoc` skips the persistence
    // provider entirely when `indexedDB` is undefined. Without this stub every
    // test here would silently exercise the no-IndexedDB path and pass whether
    // the gate exists or not.
    globalThis.indexedDB = {};
  });

  afterEach(() => {
    delete globalThis.indexedDB;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does NOT connect while the IndexedDB load is still pending', async () => {
    let releaseIdb;
    const whenSynced = new Promise((resolve) => { releaseIdb = resolve; });
    IndexeddbPersistence.mockImplementation(() => ({ whenSynced, destroy: vi.fn() }));

    renderHook(() => useYjs(nextGuid(), TEST_ACCESS_TOKEN, null));

    // Let the 0ms StrictMode delay fire and drain every microtask that is not
    // waiting on the IDB promise. Pre-fix, connect() had already happened here.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mockProvider.connect).not.toHaveBeenCalled();

    // ...and the moment the cached state has been applied, the socket opens.
    await act(async () => { releaseIdb(); });
    await waitFor(() => expect(mockProvider.connect).toHaveBeenCalled());
  });

  it('connects immediately once IndexedDB has loaded', async () => {
    IndexeddbPersistence.mockImplementation(() => ({
      whenSynced: Promise.resolve(), destroy: vi.fn(),
    }));

    renderHook(() => useYjs(nextGuid(), TEST_ACCESS_TOKEN, null));

    await waitFor(() => expect(mockProvider.connect).toHaveBeenCalled());
  });

  it('FAILS OPEN when IndexedDB never reports (blocked / private browsing)', async () => {
    // y-indexeddb builds `whenSynced` from a bare `on('synced')` subscription, so
    // a rejected or hung `openDB` leaves it forever pending. An editor that never
    // opens is worse than the rare misattribution the gate prevents.
    vi.useFakeTimers();
    IndexeddbPersistence.mockImplementation(() => ({
      whenSynced: new Promise(() => {}), destroy: vi.fn(),
    }));

    renderHook(() => useYjs(nextGuid(), TEST_ACCESS_TOKEN, null));

    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(mockProvider.connect).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(mockProvider.connect).toHaveBeenCalled();
  });

  it('does not wait at all when IndexedDB is unavailable', async () => {
    // The constructor threw (quota, disabled storage), so the hook holds no
    // provider — there is no cached state that could arrive late, and charging
    // this browser the fail-open timeout would be a pure regression.
    vi.useFakeTimers();
    IndexeddbPersistence.mockImplementation(() => { throw new Error('IDB disabled'); });

    renderHook(() => useYjs(nextGuid(), TEST_ACCESS_TOKEN, null));

    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(mockProvider.connect).toHaveBeenCalled();
  });

  it('gates the token-refresh reconnect too, so it cannot jump the queue', async () => {
    // While the initial connect waits, the provider is disconnected and
    // `shouldConnect` is false — exactly the condition the token effect treats
    // as "reconnect now". Ungated, it would open the socket first and undo the
    // gate entirely.
    let releaseIdb;
    const whenSynced = new Promise((resolve) => { releaseIdb = resolve; });
    IndexeddbPersistence.mockImplementation(() => ({ whenSynced, destroy: vi.fn() }));

    const { rerender } = renderHook(
      ({ token }) => useYjs('12345678-1234-4123-8123-00000000ffff', token, null),
      { initialProps: { token: TEST_ACCESS_TOKEN } }
    );

    // A token refresh lands while the gate is still shut.
    rerender({ token: TEST_ACCESS_TOKEN });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mockProvider.connect).not.toHaveBeenCalled();

    await act(async () => { releaseIdb(); });
    await waitFor(() => expect(mockProvider.connect).toHaveBeenCalled());
  });
});

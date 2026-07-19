/**
 * Headless binding test harness (feature 021, research R8).
 *
 * Drives the REAL ySyncPlugin from the patched @tiptap/y-tiptap against the
 * REAL app schema (derived from getBaseExtensions(), so schema parity with
 * production) inside a real prosemirror-view EditorView mounted on a jsdom
 * element — no React, no @tiptap/react. The existing Editor.test.jsx mocks
 * TipTap entirely and can never exercise the binding; this harness exists so
 * the 021 incident repros run against the code that actually ships.
 *
 * Topology: two Y.Docs ("local" — the one the editor binds — and "remote" —
 * the other collaborator) relayed both ways via Y.applyUpdate, exactly like a
 * y-websocket pair. Byte-identity assertions use encodeState() on the doc that
 * must not change.
 *
 * Fallback note (research R8): if EditorView ever proves jsdom-hostile for a
 * specific repro, pass { withView: false } to drive the plugin through a
 * minimal view shim ({ state, dispatch, hasFocus: () => false, dom }) — every
 * 021 assertion is on Y.Doc bytes and EditorState, not on rendered DOM.
 */
import * as Y from 'yjs';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { getSchema } from '@tiptap/core';
import { ySyncPlugin, ySyncPluginKey } from '@tiptap/y-tiptap';
import { getBaseExtensions } from '../extensions/editorExtensions';

const RELAY_ORIGIN = 'harness-relay';

let cachedSchema = null;

/** The production editor schema (single registry — constitution IV). */
export function getAppSchema() {
  if (!cachedSchema) {
    cachedSchema = getSchema(getBaseExtensions());
  }
  return cachedSchema;
}

/**
 * Create a two-doc harness with the editor bound to the "local" doc.
 *
 * @param {object} [options]
 * @param {boolean} [options.withView=true] real EditorView (default) or shim
 * @returns harness with { localDoc, remoteDoc, localFragment, remoteFragment,
 *   schema, view, binding, plugin, transactions, destroy, ... helpers }
 */
export function createBindingHarness({ withView = true } = {}) {
  const localDoc = new Y.Doc();
  const remoteDoc = new Y.Doc();

  const relayLocalToRemote = (update, origin) => {
    if (origin !== RELAY_ORIGIN) Y.applyUpdate(remoteDoc, update, RELAY_ORIGIN);
  };
  const relayRemoteToLocal = (update, origin) => {
    if (origin !== RELAY_ORIGIN) Y.applyUpdate(localDoc, update, RELAY_ORIGIN);
  };
  localDoc.on('update', relayLocalToRemote);
  remoteDoc.on('update', relayRemoteToLocal);

  const schema = getAppSchema();
  const localFragment = localDoc.getXmlFragment('default');
  const remoteFragment = remoteDoc.getXmlFragment('default');

  const plugin = ySyncPlugin(localFragment);
  const state = EditorState.create({ schema, plugins: [plugin] });

  /** All transactions dispatched through the view (for assertions). */
  const transactions = [];

  let view;
  let mount = null;
  if (withView) {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    view = new EditorView(mount, {
      state,
      // NOTE: uses `this` (the EditorView), not the outer `view` const — the
      // sync plugin dispatches during EditorView construction (initial
      // _forceRerender), before the const is assigned.
      dispatchTransaction(tr) {
        transactions.push(tr);
        this.updateState(this.state.apply(tr));
      },
    });
  } else {
    // Minimal view shim (research R8 fallback): enough surface for the
    // binding — state, dispatch, hasFocus, and a dom node.
    view = {
      state,
      hasFocus: () => false,
      dom: document.createElement('div'),
      dispatch(tr) {
        transactions.push(tr);
        view.state = view.state.apply(tr);
        // Mirror EditorView.updateState: the sync plugin's view spec is what
        // reacts to state updates; call its update hook manually.
        if (view._pluginView) view._pluginView.update(view, view.state);
      },
      destroy() {
        if (view._pluginView) view._pluginView.destroy();
      },
    };
    view._pluginView = plugin.spec.view(view);
  }

  const binding = ySyncPluginKey.getState(view.state).binding;

  const harness = {
    localDoc,
    remoteDoc,
    localFragment,
    remoteFragment,
    schema,
    plugin,
    view,
    binding,
    transactions,
    /**
     * Temporarily stop relaying updates between the docs — lets a test build
     * remote content and capture its pristine encoded state BEFORE the local
     * binding gets a chance to render (and, pre-patch, to damage) it.
     */
    detachRelay() {
      localDoc.off('update', relayLocalToRemote);
      remoteDoc.off('update', relayRemoteToLocal);
    },
    /**
     * Re-attach the relay and exchange any missed state both ways. The
     * remote->local catch-up applies first (triggering the local render);
     * any writes the binding performs against the local doc then relay back
     * to remote through the re-attached live relay.
     */
    attachRelay() {
      localDoc.on('update', relayLocalToRemote);
      remoteDoc.on('update', relayRemoteToLocal);
      const missedRemote = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
      if (missedRemote.length > 0) Y.applyUpdate(localDoc, missedRemote, RELAY_ORIGIN);
      const missedLocal = Y.encodeStateAsUpdate(localDoc, Y.encodeStateVector(remoteDoc));
      if (missedLocal.length > 0) Y.applyUpdate(remoteDoc, missedLocal, RELAY_ORIGIN);
    },
    destroy() {
      try {
        view.destroy();
      } finally {
        localDoc.off('update', relayLocalToRemote);
        remoteDoc.off('update', relayRemoteToLocal);
        if (mount && mount.parentNode) mount.parentNode.removeChild(mount);
        localDoc.destroy();
        remoteDoc.destroy();
      }
    },
  };
  return harness;
}

/** Encoded state for byte-for-byte identity assertions. */
export function encodeState(doc) {
  return Y.encodeStateAsUpdate(doc);
}

/** Byte-for-byte comparison of two encoded states. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Seed a paragraph with the given text on the REMOTE doc (relays to local and
 * renders through the binding). Returns the Y.XmlElement.
 */
export function insertRemoteParagraph(harness, text, index) {
  let el;
  harness.remoteDoc.transact(() => {
    el = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    el.insert(0, [t]);
    const frag = harness.remoteFragment;
    frag.insert(index === undefined ? frag.length : index, [el]);
  });
  return el;
}

/**
 * Failure injector: insert an element whose nodeName is absent from the app
 * schema — schema.node() throws naturally on render (the realistic
 * mixed-version trigger). Returns the remote Y.XmlElement.
 */
export function insertRemoteUnknownNode(harness, index, nodeName = 'squireUnknownNode021') {
  let el;
  harness.remoteDoc.transact(() => {
    el = new Y.XmlElement(nodeName);
    const frag = harness.remoteFragment;
    frag.insert(index === undefined ? frag.length : index, [el]);
  });
  return el;
}

/**
 * Failure injector: insert a KNOWN node type whose content is invalid (an
 * empty bulletList — StarterKit requires listItem+), so schema.node() throws
 * but createAndFill can produce a stand-in (DR-1/Addition-2).
 */
export function insertRemoteFillableNode(harness, index, nodeName = 'bulletList') {
  let el;
  harness.remoteDoc.transact(() => {
    el = new Y.XmlElement(nodeName);
    const frag = harness.remoteFragment;
    frag.insert(index === undefined ? frag.length : index, [el]);
  });
  return el;
}

/**
 * Failure injector for the TEXT-RUN path: a paragraph whose Y.XmlText carries
 * an unknown mark attribute — schema.mark() throws inside
 * createTextNodesFromYText (the incident's second delete-on-catch site).
 */
export function insertRemoteUnknownMarkText(harness, index, markName = 'squireUnknownMark021') {
  let el;
  harness.remoteDoc.transact(() => {
    el = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'marked text', { [markName]: {} });
    el.insert(0, [t]);
    const frag = harness.remoteFragment;
    frag.insert(index === undefined ? frag.length : index, [el]);
  });
  return el;
}

/** Await scheduled microtasks/timeouts (the binding schedules on timeout 0). */
export function flushTimers(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Names of the top-level nodes currently in the editor view. */
export function viewNodeNames(harness) {
  const names = [];
  harness.view.state.doc.forEach((node) => names.push(node.type.name));
  return names;
}

/** Names of the top-level Y children of a fragment. */
export function yNodeNames(fragment) {
  return fragment.toArray().map((t) => (t.nodeName ? t.nodeName : 'text'));
}

/** Text content of the editor view (for convergence assertions). */
export function viewText(harness) {
  return harness.view.state.doc.textContent;
}

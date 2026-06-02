import { createDiagramNode } from './diagramBlock';

let d2Promise = null;

// Singleton-promise lazy load of the D2 WASM. The browser build is a single
// self-contained ~7.9 MB file that spins up its worker via a blob URL with the
// WASM inlined (no separate .wasm/worker asset for Vite to resolve), so a plain
// dynamic import is all that's needed; it's code-split into its own chunk (see
// vite.config.js) and stays out of the main bundle until a D2 block renders.
//
// D2 runs in a single worker that tracks one in-flight request at a time, so
// concurrent compile/render calls on one instance clobber each other. Several
// D2 blocks in a document render at once, so we serialize all access through a
// promise chain on the shared instance and hand the node a thin wrapper.
function loadD2() {
  if (!d2Promise) {
    d2Promise = import('@terrastruct/d2').then(({ D2 }) => {
      const d2 = new D2();
      let chain = Promise.resolve();
      return {
        renderToSvg(source) {
          const run = chain.then(async () => {
            const result = await d2.compile(source, { layout: 'elk' });
            return d2.render(result.diagram, {
              ...result.renderOptions,
              noXMLTag: true,
            });
          });
          // Keep the chain alive past a failed render (swallow here; the real
          // error still rejects `run` for the caller).
          chain = run.then(
            () => {},
            () => {},
          );
          return run;
        },
      };
    });
  }
  return d2Promise;
}

// D2 is asked for `noXMLTag`, but trim to the opening `<svg` defensively (as
// GraphvizNode does) so `innerHTML = svg` in the node view always renders.
function toInlineSvg(out) {
  const start = out.indexOf('<svg');
  return start === -1 ? out : out.slice(start);
}

// Thin config over the shared diagram core (see diagramBlock.js). D2 uses the
// ELK layout engine. The compile step throws (with a verbose JSON-ish message)
// on invalid D2; the node view surfaces it in the error panel.
export const D2Node = createDiagramNode({
  name: 'd2',
  placeholder: 'x -> y -> z',
  loadRenderer: loadD2,
  render: async (source, d2) => toInlineSvg(await d2.renderToSvg(source)),
  // Shown when a diagram is pasted back from Google Docs but its source was too
  // large to survive the round-trip. Valid D2 so it renders as a visible node
  // rather than a bare image.
  droppedPlaceholder:
    'dropped: "⚠ D2 diagram source not preserved — too large for a Google ' +
    'Docs round-trip; re-create from the original" {\n' +
    '  style.fill: "#fef3c7"\n' +
    '  style.stroke: "#b45309"\n' +
    '  style.font-color: "#92400e"\n' +
    '}',
});

export default D2Node;

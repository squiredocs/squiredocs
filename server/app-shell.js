/**
 * Application shell injection (feature 058, research R10, RBD-058-4).
 *
 * The built client/dist/index.html no longer carries the Google tag. The server
 * (and the Vite dev server, through client/vite.config.js) inserts, right after
 * <head>:
 *
 *   - hosted only: the Google tag snippet, moved verbatim from client/index.html
 *   - always: <script>window.__SQUIRE_INSTANCE__={"hosted":true|false}</script>
 *
 * The injected object carries only the hosted flag. It is the one channel the
 * client uses to learn it (client/src/instance.js), before first render and
 * without a request.
 *
 * CommonJS with no requires, so Vite's config can load it through createRequire.
 */

// Moved verbatim from client/index.html (indentation included).
const GOOGLE_TAG_SNIPPET = `
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-9HGTDJRJWH"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-9HGTDJRJWH');
      gtag('config', 'AW-18023084061');
    </script>`;

function instanceScript(hosted) {
  return `\n    <script>window.__SQUIRE_INSTANCE__=${JSON.stringify({ hosted: hosted === true })}</script>`;
}

/**
 * @param {string} html - the client shell (index.html)
 * @param {{ hosted: boolean }} opts
 * @returns {string}
 */
function renderAppShell(html, { hosted }) {
  const match = /<head(\s[^>]*)?>/i.exec(html);
  if (!match) throw new Error('renderAppShell: no <head> element in the client shell');
  const at = match.index + match[0].length;
  const injected = (hosted === true ? GOOGLE_TAG_SNIPPET : '') + instanceScript(hosted);
  return html.slice(0, at) + injected + html.slice(at);
}

module.exports = { renderAppShell, GOOGLE_TAG_SNIPPET };

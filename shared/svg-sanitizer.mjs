/**
 * Sanitize policy for raw-SVG blocks — the single source of truth shared by
 * the client (render-time enforcement in SvgNode) and the server-side
 * validator (agent feedback in diagram-worker). SVG block content in a shared
 * document is attacker-controlled markup injected into every collaborator's
 * browser, so everything that can execute script, smuggle HTML, or phone home
 * is stripped:
 *
 *   - script / event handlers / javascript: URLs (DOMPurify defaults)
 *   - foreignObject (HTML smuggling; also taints the PNG-export canvas)
 *   - all external references — href/xlink:href may only be same-document
 *     fragments (#id) or inline data:image URIs, and url(...) values in
 *     presentation attributes/styles may only reference fragments. This
 *     blocks tracking-pixel exfiltration and keeps the rasterization canvas
 *     untainted so copy-as-PNG and PNG download keep working.
 *
 * This module deliberately does NOT import dompurify. The default export of
 * dompurify is a shared singleton (the same instance mermaid uses internally
 * when the bundler dedupes the package), so registering hooks on it would
 * leak our policy into mermaid's own sanitize calls. Callers must create an
 * isolated instance — `DOMPurify(window)` in the browser,
 * `createDOMPurify(jsdomWindow)` on the server — and pass it to
 * createSvgSanitizer().
 */

// Same-document fragment refs and inline data: images only.
export const SVG_ALLOWED_URI_REGEXP = /^(?:#|data:image\/)/i;

export const SVG_PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  NAMESPACE: 'http://www.w3.org/2000/svg',
  // foreignObject is outside the svg profile already; forbid it (and other
  // embed/HTML vectors) explicitly as belt-and-braces.
  FORBID_TAGS: ['foreignObject', 'style', 'script', 'iframe', 'form', 'audio', 'video'],
  // <use> is excluded from DOMPurify's svg profile because it can pull in
  // remote content; same-document use (icon sprites, shape reuse) is a core
  // SVG idiom and safe here — the afterSanitizeAttributes hook below strips
  // any non-#fragment href, so a re-added <use> can only clone content that
  // is itself inside the sanitized document.
  ADD_TAGS: ['use'],
  // NOTE: deliberately NOT setting ALLOWED_URI_REGEXP — DOMPurify applies it
  // as a general attribute-value filter (plain values like fill="red" or
  // cx="50" must pass it too), so narrowing it strips ordinary presentation
  // attributes. The URI restriction is enforced per URI attribute in the
  // afterSanitizeAttributes hook below instead.
};

// URI-bearing attributes whose values must satisfy SVG_ALLOWED_URI_REGEXP.
const URI_ATTRS = ['href', 'xlink:href', 'src'];

// Matches url(...) values that do NOT reference a same-document fragment,
// i.e. anything other than url(#id) / url('#id') / url("#id").
const EXTERNAL_URL_FUNC = /url\(\s*(?!['"]?\s*#)[^)]*\)/gi;

// SMIL animation elements can retarget URI attributes (attributeName="href"),
// sidestepping the URI checks that only run on the attribute itself.
const ANIMATION_TAGS = new Set(['animate', 'set', 'animatetransform', 'animatemotion']);

const MAX_REMOVED_ENTRIES = 10;

/**
 * Bind the sanitize policy to an isolated DOMPurify instance.
 *
 * @param {import('dompurify').DOMPurify} purify - environment-bound instance
 *   created via the dompurify factory (never the shared default export).
 * @returns {{ sanitizeSvg: (source: string) => { svg: string, removed: string[] } }}
 */
export function createSvgSanitizer(purify) {
  // Rewrites the hook records into this per-call list (purify.removed only
  // covers DOMPurify's own removals, not our hook's).
  let hookRemoved = [];

  purify.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.tagName ? node.tagName.toLowerCase() : '';

    // Drop SMIL animations that target URI attributes.
    if (ANIMATION_TAGS.has(tag)) {
      const target = (node.getAttribute('attributeName') || '').toLowerCase();
      if (target === 'href' || target === 'xlink:href') {
        hookRemoved.push(`element <${tag} attributeName="${target}">`);
        node.remove();
        return;
      }
    }

    // URI attributes may only reference same-document fragments (#id) or
    // inline data: images. DOMPurify's defaults already kill javascript: —
    // this additionally blocks external http(s) references (tracking pixels,
    // canvas taint).
    for (const name of URI_ATTRS) {
      const value = node.getAttribute && node.getAttribute(name);
      if (value && !SVG_ALLOWED_URI_REGEXP.test(value.trim())) {
        hookRemoved.push(`external reference in attribute ${name}`);
        node.removeAttribute(name);
      }
    }

    // Rewrite external url(...) references (style, fill, filter, clip-path,
    // mask, marker-*, …) to `none`, keeping only url(#fragment).
    for (const attr of Array.from(node.attributes || [])) {
      if (!attr.value || !/url\s*\(/i.test(attr.value)) continue;
      const rewritten = attr.value.replace(EXTERNAL_URL_FUNC, 'none');
      if (rewritten !== attr.value) {
        hookRemoved.push(`external url() in attribute ${attr.name}`);
        node.setAttribute(attr.name, rewritten);
      }
    }
  });

  /**
   * Sanitize raw SVG source for rendering.
   *
   * @param {string} source - raw SVG markup (the block's text content)
   * @returns {{ svg: string, removed: string[] }} sanitized markup plus a
   *   deduped, capped summary of what was stripped (empty when unchanged).
   * @throws {Error} when the source has no <svg> root, or nothing renderable
   *   survives sanitization — messages drive the editor's error panel.
   */
  function sanitizeSvg(source) {
    const trimmed = (source || '').trim();
    if (!/<svg[\s>/]/i.test(trimmed)) {
      throw new Error('SVG block must contain an <svg>…</svg> element');
    }

    hookRemoved = [];
    const clean = purify.sanitize(trimmed, SVG_PURIFY_CONFIG);

    if (!/<svg[\s>/]/i.test(clean)) {
      // DOMPurify fails closed (empties the whole document) on structural
      // violations, most commonly an xlink:href attribute without the
      // xmlns:xlink namespace declaration on the <svg> root.
      throw new Error(
        'SVG contained no renderable content after sanitization (disallowed '
          + 'content was removed). Common causes: only disallowed elements, or '
          + 'xlink:href used without xmlns:xlink="http://www.w3.org/1999/xlink" '
          + 'declared on the <svg> root — prefer plain href.',
      );
    }

    const removed = new Set(hookRemoved);
    for (const entry of purify.removed || []) {
      if (entry.element && entry.element.nodeName) {
        const tag = String(entry.element.nodeName).toLowerCase();
        // DOMPurify's parsing wrapper, not user content.
        if (tag === 'template' || tag === 'body' || tag === '#comment') continue;
        removed.add(`element <${tag}>`);
      } else if (entry.attribute && entry.attribute.name) {
        removed.add(`attribute ${entry.attribute.name}`);
      }
    }

    return { svg: clean, removed: [...removed].slice(0, MAX_REMOVED_ENTRIES) };
  }

  return { sanitizeSvg };
}

export default createSvgSanitizer;

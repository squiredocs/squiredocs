/**
 * site-footer.mjs — the single source of truth for the marketing footer.
 *
 * Consumed three ways:
 *  - render-documentation.mjs and render-blog.mjs import FOOTER directly.
 *  - sync-footer.mjs stamps FOOTER into the static pages in public/
 *    (landing, pricing, about, security) between site-footer markers.
 *
 * To change the footer: edit FOOTER here, then run `npm run sync:footer`
 * (also runs automatically at the start of `npm run build`).
 */

export const FOOTER_START = '<!-- site-footer:start (generated from scripts/site-footer.mjs — edit there, then `npm run sync:footer`) -->';
export const FOOTER_END = '<!-- site-footer:end -->';

export const FOOTER = `    <footer class="landing-footer">
      <div class="landing-footer-content">
        <div class="landing-footer-top">
          <div class="landing-footer-brand">
            <a href="/" class="landing-footer-logo">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
                <path d="M7.5 7.5h8" stroke-width="1" />
                <path d="M13.5 5.5l2.5 2-2.5 2" stroke-width="1" />
                <path d="M7.5 12h8" stroke-width="1" />
                <path d="M7.5 16.5h8" stroke-width="1" />
              </svg>
              <span>Squire Docs</span>
            </a>
            <p class="landing-footer-tagline">Write with AI, right in your doc</p>
          </div>
          <div class="landing-footer-links">
            <div class="landing-footer-column">
              <h4>Product</h4>
              <ul>
                <li><a href="/pricing">Pricing</a></li>
                <li><a href="/about">About</a></li>
                <li><a href="/documentation">Documentation</a></li>
                <li><a href="/blog">Blog</a></li>
                <li><a href="/agents.md">Agents</a></li>
                <li><a href="https://github.com/squiredocs">GitHub</a></li>
                <li><a href="/signup">Sign Up</a></li>
                <li><a href="/login">Sign In</a></li>
              </ul>
            </div>
            <div class="landing-footer-column">
              <h4>Legal</h4>
              <ul>
                <li><a href="/privacy">Privacy Policy</a></li>
                <li><a href="/terms">Terms of Service</a></li>
              </ul>
            </div>
            <div class="landing-footer-column">
              <h4>Contact</h4>
              <ul>
                <li><a href="mailto:contact@squiredocs.com">contact@squiredocs.com</a></li>
              </ul>
            </div>
          </div>
        </div>
        <div class="landing-footer-bottom">
          <p class="landing-copyright">&copy; 2026 21st Harmonic LLC</p>
        </div>
      </div>
    </footer>`;

/** The full marker-wrapped block as it appears in the static pages. */
export const MARKED_FOOTER = `    ${FOOTER_START}
${FOOTER}
    ${FOOTER_END}`;

/**
 * Return html with its footer replaced by the canonical marker-wrapped block.
 * Replaces an existing marker block, or bootstraps by replacing a raw
 * `<footer class="landing-footer">...</footer>` element. Throws if the page
 * has neither, so a page can never silently lose its footer.
 */
export function syncFooterIntoHtml(html) {
  const markerBlock = /[ \t]*<!-- site-footer:start[\s\S]*?<!-- site-footer:end -->/;
  if (markerBlock.test(html)) {
    return html.replace(markerBlock, MARKED_FOOTER);
  }
  const rawFooter = /[ \t]*<footer class="landing-footer">[\s\S]*?<\/footer>/;
  if (rawFooter.test(html)) {
    return html.replace(rawFooter, MARKED_FOOTER);
  }
  throw new Error('no site footer found to sync');
}

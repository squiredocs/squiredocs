import { describe, it, expect, beforeEach } from 'vitest';
import DOMPurify from 'dompurify';
import { createSvgSanitizer } from '../../../../shared/svg-sanitizer.mjs';

// The sanitize policy is the security boundary for SVG blocks: block content
// is attacker-controlled markup (any collaborator or agent can write it) that
// DiagramNodeView injects into every viewer's DOM via innerHTML. These tests
// pin the policy itself; SvgNode.js is just a thin binding over it.

describe('createSvgSanitizer', () => {
  let sanitizeSvg;

  beforeEach(() => {
    // Isolated instance per test — never the shared default export (hooks on
    // it would leak into mermaid's internal sanitize calls).
    const purify = DOMPurify(window);
    ({ sanitizeSvg } = createSvgSanitizer(purify));
  });

  const wrap = (inner, attrs = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg"${attrs ? ` ${attrs}` : ''}>${inner}</svg>`;

  describe('XSS vectors', () => {
    it('strips <script> elements', () => {
      const { svg, removed } = sanitizeSvg(wrap('<script>alert(1)</script><rect width="5" height="5"/>'));
      expect(svg).not.toContain('script');
      expect(svg).toContain('<rect');
      expect(removed).toContain('element <script>');
    });

    it('strips event handler attributes', () => {
      const { svg, removed } = sanitizeSvg(
        wrap('<rect width="5" height="5" onclick="alert(1)"/>', 'onload="alert(2)"'),
      );
      expect(svg).not.toContain('onclick');
      expect(svg).not.toContain('onload');
      expect(removed).toEqual(expect.arrayContaining(['attribute onclick', 'attribute onload']));
    });

    it('strips javascript: hrefs on links', () => {
      const { svg } = sanitizeSvg(wrap('<a href="javascript:alert(1)"><text y="10">x</text></a>'));
      expect(svg).not.toContain('javascript:');
      expect(svg).toContain('<text');
    });

    it('strips foreignObject (HTML smuggling)', () => {
      const { svg, removed } = sanitizeSvg(
        wrap('<foreignObject><iframe src="https://evil.example"></iframe></foreignObject><circle r="4"/>'),
      );
      expect(svg).not.toContain('foreignObject');
      expect(svg).not.toContain('iframe');
      expect(svg).toContain('<circle');
      expect(removed).toContain('element <foreignobject>');
    });

    it('strips <style> elements', () => {
      const { svg } = sanitizeSvg(wrap('<style>rect{fill:red}</style><rect width="5" height="5"/>'));
      expect(svg).not.toContain('<style');
    });

    it('removes SMIL animations that retarget href', () => {
      const { svg } = sanitizeSvg(
        wrap('<a href="#x"><animate attributeName="href" to="javascript:alert(1)"/><text y="10">x</text></a>'),
      );
      expect(svg).not.toContain('animate');
      expect(svg).not.toContain('javascript:');
    });
  });

  describe('external references (exfiltration / canvas taint)', () => {
    it('strips external http(s) href / xlink:href', () => {
      const { svg, removed } = sanitizeSvg(
        wrap(
          '<image href="https://evil.example/track.png" width="5" height="5"/>'
            + '<use xlink:href="http://evil.example/defs.svg#icon"/>',
          'xmlns:xlink="http://www.w3.org/1999/xlink"',
        ),
      );
      expect(svg).not.toContain('evil.example');
      expect(removed.some((r) => r.includes('external reference'))).toBe(true);
    });

    it('fails closed on xlink:href without the xmlns:xlink declaration', () => {
      // DOMPurify treats an undeclared xlink: prefix as a namespace violation
      // and empties the document; sanitizeSvg surfaces that as a clear error.
      expect(() =>
        sanitizeSvg(wrap('<use xlink:href="#dot"/>')),
      ).toThrow(/xmlns:xlink/);
    });

    it('keeps same-document #fragment refs', () => {
      const { svg } = sanitizeSvg(
        wrap('<defs><circle id="dot" r="2"/></defs><use href="#dot"/>'),
      );
      expect(svg).toContain('href="#dot"');
    });

    it('keeps inline data:image hrefs', () => {
      const { svg } = sanitizeSvg(
        wrap('<image href="data:image/png;base64,AAAA" width="5" height="5"/>'),
      );
      expect(svg).toContain('data:image/png;base64,AAAA');
    });

    it('keeps url(#fragment) but rewrites external url(...) to none', () => {
      const { svg, removed } = sanitizeSvg(
        wrap(
          '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>'
            + '<rect width="5" height="5" fill="url(#g)"/>'
            + '<rect width="5" height="5" fill="url(https://evil.example/f.svg#p)"/>',
        ),
      );
      expect(svg).toContain('fill="url(#g)"');
      expect(svg).not.toContain('evil.example');
      expect(svg).toContain('fill="none"');
      expect(removed.some((r) => r.includes('external url()'))).toBe(true);
    });

    it('rewrites external url(...) inside style attributes', () => {
      const { svg } = sanitizeSvg(
        wrap('<rect width="5" height="5" style="fill: url(https://evil.example/f)"/>'),
      );
      expect(svg).not.toContain('evil.example');
    });
  });

  describe('benign content', () => {
    it('passes a typical SVG through intact', () => {
      const source = wrap(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>'
          + '<circle cx="50" cy="50" r="40" fill="url(#g)" stroke="#333" stroke-width="2"/>'
          + '<text x="10" y="20" font-family="sans-serif" font-size="12">hello</text>',
        'viewBox="0 0 100 100" width="100" height="100"',
      );
      const { svg, removed } = sanitizeSvg(source);
      expect(removed).toEqual([]);
      // Attribute-preserving: everything meaningful survives.
      for (const bit of ['viewBox="0 0 100 100"', 'cx="50"', 'fill="url(#g)"', 'stroke="#333"', 'font-size="12"', '>hello<']) {
        expect(svg).toContain(bit);
      }
    });

    it('reports nothing removed for clean input', () => {
      const { removed } = sanitizeSvg(wrap('<rect width="5" height="5" fill="red"/>'));
      expect(removed).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('throws when the source has no <svg> root', () => {
      expect(() => sanitizeSvg('just some text')).toThrow(/<svg>/);
      expect(() => sanitizeSvg('<div>html</div>')).toThrow(/<svg>/);
      expect(() => sanitizeSvg('')).toThrow(/<svg>/);
    });

    it('throws when nothing renderable survives sanitization', () => {
      // A lone <script> masquerading with an svg prefix in text form.
      expect(() => sanitizeSvg('<script>alert(1)</script><svg')).toThrow();
    });
  });
});

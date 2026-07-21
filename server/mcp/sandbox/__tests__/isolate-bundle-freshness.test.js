/**
 * Tripwire for the checked-in isolate bundle (feature 027 review F1).
 *
 * The sandbox executes the COMMITTED esbuild artifact, not the live source —
 * nothing in Docker/CI rebuilds it, so a source fix that isn't re-bundled
 * silently never ships to the isolate. That happened with 027: the host-side
 * cursor-operations fix landed while the bundle still carried the
 * placeholder-inserting branches, letting a modify script's xpath() persist
 * a write from position math.
 *
 * These assertions pin the 027 invariant inside the artifact itself. If a
 * legitimate cursor-operations change trips them, rebuild the bundle
 * (`npm run build:sandbox-bundle`), commit it alongside the source change,
 * and update the patterns only if the invariant itself moved.
 */
const fs = require('fs');
const path = require('path');

const BUNDLE_PATH = path.join(__dirname, '..', 'isolate-bundle.js');

describe('isolate-bundle freshness (027 reads-never-write)', () => {
  let bundle;

  beforeAll(() => {
    bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
  });

  test('carries the element-boundary anchoring construction', () => {
    expect(bundle).toContain('createRelativePositionFromTypeIndex');
  });

  test('does not carry the placeholder-inserting position fallback', () => {
    // The pre-027 idiom: construct an empty XmlText and insert it into the
    // block purely to make a position computable. Namespace alias (Y, Y2, …)
    // is esbuild-generated, so match any identifier.
    const placeholderIdiom = /new\s+\w+\.XmlText\(\)[\s\S]{0,300}?\.insert\(\s*0\s*,\s*\[\s*\w*[tT]extNode\s*\]\s*\)/;
    expect(bundle).not.toMatch(placeholderIdiom);
  });
});

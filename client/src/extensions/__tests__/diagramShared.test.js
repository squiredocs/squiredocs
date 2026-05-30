import { describe, it, expect } from 'vitest';
import {
  fitRasterScale,
  encodeSourceForAlt,
  decodeSourceFromAlt,
} from '../diagramShared';

describe('fitRasterScale', () => {
  it('keeps the requested scale for small diagrams', () => {
    // 400×300 @2× → 800×600, well under the 2000px cap.
    expect(fitRasterScale(400, 300, 2, 2000)).toBe(2);
  });

  it('downscales a large diagram so the longest side fits the cap', () => {
    // A wide Graphviz graph: 3000pt wide. 2× would be 6000px → too big for
    // Google Docs. Cap the longest side at 2000px → scale 2000/3000.
    expect(fitRasterScale(3000, 700, 2, 2000)).toBeCloseTo(2000 / 3000);
  });

  it('never upscales past the requested scale', () => {
    // Tiny diagram: 2000/50 = 40 would upscale, but scale is the ceiling.
    expect(fitRasterScale(50, 50, 2, 2000)).toBe(2);
  });

  it('uses the longest side (width or height) for the cap', () => {
    expect(fitRasterScale(700, 3000, 2, 2000)).toBeCloseTo(2000 / 3000);
  });

  it('does not divide by zero on a degenerate size', () => {
    expect(Number.isFinite(fitRasterScale(0, 0, 2, 2000))).toBe(true);
  });
});

describe('alt source round-trip', () => {
  it('encodes and decodes a multiline Graphviz source losslessly', () => {
    const src = 'digraph {\n  A -> B [label="x>y & z"]\n}';
    const alt = encodeSourceForAlt('graphviz', src);
    expect(decodeSourceFromAlt('graphviz', alt)).toBe(src);
  });

  it('returns null for a mismatched prefix', () => {
    const alt = encodeSourceForAlt('mermaid', 'graph TD; A-->B');
    expect(decodeSourceFromAlt('graphviz', alt)).toBe(null);
  });
});

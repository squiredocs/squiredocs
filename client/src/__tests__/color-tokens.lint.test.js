/**
 * Migration completeness gate (FR-013 / SC-003), wired into Vitest.
 *
 * This asserts that ZERO disallowed color literals remain in migrated CSS — the
 * same assertion as `npm run lint:colors`. Per orchestrator disposition O1 it was
 * kept `describe.skip` while the token migration was mid-flight; the T043 join
 * gate has now passed (every migration task landed and `npm run lint:colors`
 * reports 0), so it is a LIVE gate that keeps future color drift impossible.
 */
import { describe, it, expect } from 'vitest';
import { findViolations } from '../../scripts/check-color-tokens.mjs';

describe('color-token migration completeness (lint:colors)', () => {
  it('has zero disallowed color literals in chrome CSS', () => {
    const violations = findViolations();
    const report = violations
      .map((v) => `${v.file}:${v.line}  ${v.literal}  in  ${v.selector}`)
      .join('\n');
    expect(violations, `\n${report}`).toHaveLength(0);
  });
});

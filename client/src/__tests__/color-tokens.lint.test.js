/**
 * Migration completeness gate (FR-013 / SC-003), wired into Vitest.
 *
 * This asserts that ZERO disallowed color literals remain in chrome CSS — the
 * same assertion as `npm run lint:colors`. Per orchestrator disposition O1 it is
 * kept `describe.skip` while the token migration is mid-flight so the suite does
 * not go red before the migration join gate (T043) passes. TODO(T043): remove
 * `.skip` once every migration task (T012–T041) has landed and the standalone
 * `npm run lint:colors` reports 0 — that is the moment this becomes a live gate.
 */
import { describe, it, expect } from 'vitest';
import { findViolations } from '../../scripts/check-color-tokens.mjs';

// TODO(T043): change `describe.skip` → `describe` once the migration join gate passes.
describe.skip('color-token migration completeness (lint:colors)', () => {
  it('has zero disallowed color literals in chrome CSS', () => {
    const violations = findViolations();
    const report = violations
      .map((v) => `${v.file}:${v.line}  ${v.literal}  in  ${v.selector}`)
      .join('\n');
    expect(violations, `\n${report}`).toHaveLength(0);
  });
});

/**
 * Feature 058 (T047): isHosted() is true only for the literal boolean true the
 * server injects into the shell.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isHosted } from '../instance';

describe('isHosted', () => {
  afterEach(() => {
    delete window.__SQUIRE_INSTANCE__;
  });

  it('is false with no injection', () => {
    expect(isHosted()).toBe(false);
  });

  it('is true only for the boolean true', () => {
    window.__SQUIRE_INSTANCE__ = { hosted: true };
    expect(isHosted()).toBe(true);
    for (const v of [false, 'true', 1, null, undefined]) {
      window.__SQUIRE_INSTANCE__ = { hosted: v };
      expect(isHosted()).toBe(false);
    }
  });
});

/**
 * Execution-scoped sandbox origins must be unique per execution (review L6).
 *
 * The bridge tags every incremental update of one execution with its
 * sandboxOrigin and merges them into ONE transient rollback stack item.
 * 'sandbox-exec-' + Date.now() collides for executions starting in the same
 * millisecond, so a script error in one execution could revert a concurrent
 * execution's updates. The origin now carries a monotonic sequence suffix.
 */
const { makeSandboxOrigin } = require('../sandbox/bridge');

describe('makeSandboxOrigin', () => {
  test('origins minted in the same millisecond are unique', () => {
    const minted = new Set();
    const count = 1000; // far more than one ms worth of calls
    for (let i = 0; i < count; i++) {
      minted.add(makeSandboxOrigin());
    }
    expect(minted.size).toBe(count);
  });

  test('keeps the sandbox-exec- prefix contract', () => {
    expect(makeSandboxOrigin()).toMatch(/^sandbox-exec-\d+-\d+$/);
  });
});

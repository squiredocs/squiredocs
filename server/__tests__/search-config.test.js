/**
 * Feature 018 — shared search-configuration surface (FR-026).
 *
 * Contract: specs/018-search-chunking-and-eval/contracts/search-config.md
 * One resolver (`getSearchConfig(overrides)`), env → default per knob,
 * overrides win, SEARCH_RERANK default OFF (FR-030).
 */

const CONFIG_ENV_VARS = ['SEARCH_PREAMBLES', 'SEARCH_RERANK', 'SEARCH_CHUNK_TOKENS'];

describe('getSearchConfig (018 config surface)', () => {
  let saved;

  beforeEach(() => {
    saved = {};
    for (const key of CONFIG_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function load() {
    // Re-require fresh so env changes are observed at call time, not cached.
    const { getSearchConfig } = require('../search/config');
    return getSearchConfig;
  }

  test('defaults match the contract table', () => {
    const cfg = load()();
    expect(cfg).toEqual({
      chunking: 'structure',
      preambles: true,
      rerank: false,
      chunkTargetTokens: 600,
      headingFillRatio: 0.5,
      overlapRatio: 0.12,
      distanceThreshold: 0.5,
    });
  });

  test('rerank defaults OFF and only the flag turns it on (FR-030)', () => {
    const getSearchConfig = load();
    expect(getSearchConfig().rerank).toBe(false);
    process.env.SEARCH_RERANK = 'true';
    expect(getSearchConfig().rerank).toBe(true);
    process.env.SEARCH_RERANK = 'on';
    expect(getSearchConfig().rerank).toBe(true);
    process.env.SEARCH_RERANK = '1';
    expect(getSearchConfig().rerank).toBe(true);
    process.env.SEARCH_RERANK = 'off';
    expect(getSearchConfig().rerank).toBe(false);
    process.env.SEARCH_RERANK = 'false';
    expect(getSearchConfig().rerank).toBe(false);
    process.env.SEARCH_RERANK = 'garbage';
    expect(getSearchConfig().rerank).toBe(false);
  });

  test('boolean env parsing: 1|true|on|yes case-insensitive', () => {
    const getSearchConfig = load();
    for (const v of ['1', 'true', 'TRUE', 'on', 'On', 'yes', 'YES']) {
      process.env.SEARCH_PREAMBLES = v;
      expect(getSearchConfig().preambles).toBe(true);
    }
    for (const v of ['0', 'false', 'off', 'no', 'nope', '']) {
      process.env.SEARCH_PREAMBLES = v;
      // empty string means unset → default (true); others are false
      const expected = v === '' ? true : false;
      expect(getSearchConfig().preambles).toBe(expected);
    }
  });

  test('SEARCH_CHUNK_TOKENS env parses as integer with fallback', () => {
    const getSearchConfig = load();
    process.env.SEARCH_CHUNK_TOKENS = '450';
    expect(getSearchConfig().chunkTargetTokens).toBe(450);
    process.env.SEARCH_CHUNK_TOKENS = 'not-a-number';
    expect(getSearchConfig().chunkTargetTokens).toBe(600);
  });

  test('overrides win over env and defaults', () => {
    const getSearchConfig = load();
    process.env.SEARCH_PREAMBLES = 'true';
    process.env.SEARCH_RERANK = 'true';
    process.env.SEARCH_CHUNK_TOKENS = '450';
    const cfg = getSearchConfig({
      chunking: 'fixed',
      preambles: false,
      rerank: false,
      chunkTargetTokens: 300,
      headingFillRatio: 0.7,
      overlapRatio: 0,
      distanceThreshold: 0.4,
    });
    expect(cfg).toEqual({
      chunking: 'fixed',
      preambles: false,
      rerank: false,
      chunkTargetTokens: 300,
      headingFillRatio: 0.7,
      overlapRatio: 0,
      distanceThreshold: 0.4,
    });
  });

  test('falsy-but-defined overrides are honored (0 overlap, false preambles)', () => {
    const cfg = load()({ overlapRatio: 0, preambles: false });
    expect(cfg.overlapRatio).toBe(0);
    expect(cfg.preambles).toBe(false);
  });

  test('chunking has no env var: only overrides select the fixed baseline', () => {
    const getSearchConfig = load();
    process.env.SEARCH_CHUNKING = 'fixed'; // must be ignored — not part of the surface
    try {
      expect(getSearchConfig().chunking).toBe('structure');
      expect(getSearchConfig({ chunking: 'fixed' }).chunking).toBe('fixed');
    } finally {
      delete process.env.SEARCH_CHUNKING;
    }
  });
});

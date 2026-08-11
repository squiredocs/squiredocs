/**
 * Trigger-word contract for first-seen surfaces (feature 019, US2/T015 —
 * FR-009..FR-015, SC-004/SC-005, contracts/teaching-surfaces.md §1).
 *
 * External agents pattern-match on tool names, title lines, and parameter
 * schemas — the words "sync", "import", "existing file", and the byte-channel
 * redirect must sit exactly where such an agent looks. Assertions are
 * tolerant regexes on the normative words (research R7), except the
 * design-pinned already-read-it clause.
 *
 * The per-surface byte re-assertions deliberately duplicate the registry-wide
 * gate in tool-modules.test.js — this suite documents the trigger contract on
 * its own.
 */
const createDocument = require('../../tools/create-document');
const modify = require('../../tools/modify');
const getToolDocumentation = require('../../tools/get-tool-documentation');
const importMarkdownFile = require('../../tools/import-markdown-file');
const { SERVER_INSTRUCTIONS } = require('../../index');

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const firstLine = (s) => s.split('\n')[0];

describe('trigger surfaces (SC-005)', () => {
  describe('create_document', () => {
    test('title (first) line names syncing/importing an EXISTING file as the excluded case (FR-009)', () => {
      const line = firstLine(createDocument.description);
      expect(line).toMatch(/sync|import/i);
      expect(line).toMatch(/existing/i);
      expect(line).toMatch(/\bnot\b|don't|never/i);
    });

    test('byte-channel redirect carries the already-read-it sentence (FR-010)', () => {
      // Design-pinned clause: even if the file has already been read, the
      // file remains the source of truth — use the byte channel.
      expect(createDocument.description).toMatch(/already read (the|this) file/i);
      expect(createDocument.description).toMatch(/remains the source of truth/i);
    });

    test('the markdown PARAMETER SCHEMA description carries the redirect (FR-011)', () => {
      const paramDesc = createDocument.inputSchema.properties.markdown.description;
      expect(paramDesc).toMatch(/existing file|file that already exists|already exists as a file/i);
      expect(paramDesc).toMatch(/retype|byte channel|\/api\/docs\/import/i);
    });

    test('description keeps the contract content the trim must not drop (FR-012 guardrail)', () => {
      const d = createDocument.description;
      // Title precedence and the at-least-one-of rule survive the diet.
      expect(d).toMatch(/title precedence|precedence/i);
      expect(d).toMatch(/at least one of/i);
      expect(d).toMatch(/incremental/i);
    });

    test('description is ≤ 2,048 UTF-8 bytes (SC-004)', () => {
      expect(bytes(createDocument.description)).toBeLessThanOrEqual(2048);
    });
  });

  describe('modify', () => {
    test('redirect covers "or syncing" and names mode=sync (FR-013)', () => {
      expect(modify.description).toMatch(/or syncing/i);
      expect(modify.description).toContain('mode=sync');
    });

    test('the NON-NEGOTIABLE RULES block is gone (canonical home: get_tool_documentation)', () => {
      expect(modify.description).not.toContain('NON-NEGOTIABLE RULES');
    });

    test('still names XPath-not-positional and get_tool_documentation (trim guardrail)', () => {
      expect(modify.description).toMatch(/xpath/i);
      expect(modify.description).toMatch(/positional/i);
      expect(modify.description).toContain('get_tool_documentation');
    });

    test('description is ≤ 2,048 UTF-8 bytes — over the cap before 019 (SC-004)', () => {
      expect(bytes(modify.description)).toBeLessThanOrEqual(2048);
    });
  });

  describe('get_tool_documentation', () => {
    test('headline (first line) names the REST byte channel and rest_api alongside the script tools (FR-014)', () => {
      const line = firstLine(getToolDocumentation.description);
      expect(line).toMatch(/REST|byte channel/i);
      expect(line).toContain('rest_api');
    });
  });

  describe('server instructions', () => {
    test('CHANNEL RULE contains the trigger phrase "to sync/import an existing file" (FR-015)', () => {
      expect(SERVER_INSTRUCTIONS).toContain('to sync/import an existing file');
    });

    test('instructions are ≤ 1,536 UTF-8 bytes (RBD-7/SC-004)', () => {
      expect(bytes(SERVER_INSTRUCTIONS)).toBeLessThanOrEqual(1536);
    });
  });

  // Feature 054 (US5/FR-016, SC-007). The channel rule says which CHANNEL bytes
  // travel over; the split says which TOOL to reach for, which is the question
  // agents were getting wrong. Both budgeted surfaces are tight, so the split
  // is exactly the sort of sentence a future byte-trimming edit would drop
  // first. These pins make that a test failure rather than a quiet regression.
  describe('the whole-file-vs-targeted-edit split (054)', () => {
    test('SERVER_INSTRUCTIONS states both halves of the split', () => {
      expect(SERVER_INSTRUCTIONS).toContain('bulk updates');
      expect(SERVER_INSTRUCTIONS).toMatch(/actively editing/i);
      expect(SERVER_INSTRUCTIONS).toMatch(/prefer modify/i);
    });

    test('modify.description states both halves of the split', () => {
      expect(modify.description).toContain('bulk update');
      expect(modify.description).toMatch(/actively editing/i);
      expect(modify.description).toMatch(/damaged node/i);
    });

    test('import_markdown_file.description states both halves of the split', () => {
      expect(importMarkdownFile.description).toContain('bulk updates');
      expect(importMarkdownFile.description).toMatch(/actively edited/i);
      expect(importMarkdownFile.description).toMatch(/damaged/i);
    });

    test('the split did not push any budgeted surface over its cap', () => {
      expect(bytes(SERVER_INSTRUCTIONS)).toBeLessThanOrEqual(1536);
      expect(bytes(modify.description)).toBeLessThanOrEqual(2048);
      expect(bytes(importMarkdownFile.description)).toBeLessThanOrEqual(2048);
    });
  });

  describe('import_markdown_file', () => {
    test('first line contains "sync" (FR-006 — the tool-list affordance)', () => {
      expect(firstLine(importMarkdownFile.description).toLowerCase()).toContain('sync');
    });
  });
});

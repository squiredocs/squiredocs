/**
 * Word-level diff marks are diff-service-provenance ONLY (feature 022, US3).
 *
 * FR-009 / SC-009: diffInsertWord / diffDeleteWord are registered so
 * VersionPreview can render them, but NO input rule, keyboard shortcut, or
 * command creates them — a normal edit never produces them. Guarded two ways:
 *   1. their extension config matches the plain diff marks (which have no
 *      rules/shortcuts/commands), so nobody quietly added an editing path;
 *   2. a real headless editor round-trips plain editing without ever emitting
 *      the marks.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { getBaseExtensions } from '../editorExtensions';

let editor;
afterEach(() => {
  if (editor) { editor.destroy(); editor = undefined; }
});

describe('word-level diff marks — diff-service provenance only (FR-009/SC-009)', () => {
  it('are registered in the base extension set', () => {
    const names = getBaseExtensions().map((e) => e.name);
    expect(names).toContain('diffInsertWord');
    expect(names).toContain('diffDeleteWord');
  });

  it('define no input rules, keyboard shortcuts, or commands (same as the plain diff marks)', () => {
    const exts = getBaseExtensions();
    const plain = {
      diffInsertWord: exts.find((e) => e.name === 'diffInsert'),
      diffDeleteWord: exts.find((e) => e.name === 'diffDelete'),
    };
    for (const markName of ['diffInsertWord', 'diffDeleteWord']) {
      const ext = exts.find((e) => e.name === markName);
      const ref = plain[markName];
      // The plain diff marks have no editing path; the word marks must match.
      expect(ext.config.addInputRules).toBe(ref.config.addInputRules);
      expect(ext.config.addKeyboardShortcuts).toBe(ref.config.addKeyboardShortcuts);
      expect(ext.config.addCommands).toBe(ref.config.addCommands);
    }
  });

  it('a normal edit round-trips through save/load without producing the word marks', () => {
    editor = new Editor({
      extensions: getBaseExtensions(),
      content: '<p>hello world</p>',
    });
    // Real edits: insert text, select all, apply genuine formatting.
    editor.commands.focus();
    editor.commands.insertContent(' and then some more text');
    editor.commands.selectAll();
    editor.commands.toggleBold();
    editor.commands.toggleItalic();

    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toContain('diffInsertWord');
    expect(json).not.toContain('diffDeleteWord');
    // sanity: genuine marks DID get produced, proving edits actually ran
    expect(json).toContain('bold');
  });
});

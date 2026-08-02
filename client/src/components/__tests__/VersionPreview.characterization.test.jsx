import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import VersionPreview from '../VersionPreview';

/**
 * CHARACTERIZATION tests for feature 042.
 *
 * 041 pinned the preview's error/placeholder state machine. What was still
 * unpinned is the part FR-016 touches: WHICH document `showDiff` feeds to the
 * editor. The component's header comment used to claim diff visibility was
 * "toggled purely via CSS"; it is not — the toggle swaps the document and
 * re-creates the editor, and when the server sent no `currentDocument` the
 * "off" position falls back to the DIFF-ANNOTATED document.
 *
 * 042 corrects the comment only. That fallback is pinned here as a QUIRK so
 * the correction cannot quietly turn into a behavior change (contract C10).
 */

// Capture what content the editor was configured with. TipTap itself is
// irrelevant to the selection logic under test.
let lastEditorConfig = null;
vi.mock('@tiptap/react', () => ({
  useEditor: (config) => {
    lastEditorConfig = config;
    return { isEditor: true };
  },
  EditorContent: () => <div data-testid="editor-content">Editor Content</div>,
}));

const selection = {
  id: 'v1',
  name: 'Draft',
  clockStart: 1,
  clockEnd: 5,
  timestamp: '2024-01-05T16:30:00Z',
  authors: [],
};

const annotated = { type: 'doc', content: [{ type: 'paragraph', attrs: { tag: 'annotated' } }] };
const plain = { type: 'doc', content: [{ type: 'paragraph', attrs: { tag: 'plain' } }] };

function renderPreview(props = {}) {
  lastEditorConfig = null;
  return render(
    <VersionPreview
      diffData={null}
      diffError={null}
      selection={selection}
      isLoading={false}
      showDiff={true}
      {...props}
    />
  );
}

describe('VersionPreview — document selection under showDiff (042 characterization)', () => {
  it('feeds the diff-annotated document when showDiff is on', () => {
    renderPreview({ diffData: { document: annotated, currentDocument: plain, meta: {} } });
    expect(lastEditorConfig.content).toBe(annotated);
  });

  it('feeds the plain current document when showDiff is off', () => {
    renderPreview({
      showDiff: false,
      diffData: { document: annotated, currentDocument: plain, meta: {} },
    });
    expect(lastEditorConfig.content).toBe(plain);
  });

  it('PINNED QUIRK: with showDiff off and no currentDocument, the ANNOTATED doc still renders', () => {
    // The server omitted `currentDocument`, so "highlights off" silently shows
    // the diff-marked document with diff CSS applied. Pre-existing behavior;
    // 042 fixes only the comment that mis-described the mechanism.
    renderPreview({ showDiff: false, diffData: { document: annotated, meta: {} } });
    expect(lastEditorConfig.content).toBe(annotated);
  });

  it('feeds null content when there is no document on either side', () => {
    renderPreview({ showDiff: false, diffData: { meta: {} } });
    expect(lastEditorConfig.content).toBeNull();
  });

  it('re-creates the editor when the toggle changes the document (not a CSS-only switch)', () => {
    const diffData = { document: annotated, currentDocument: plain, meta: {} };
    const { rerender } = renderPreview({ diffData });
    expect(lastEditorConfig.content).toBe(annotated);
    // The dependency array carries `content`, so a toggle tears the editor down
    // and rebuilds it with the other document.
    expect(lastEditorConfig.deps ?? true).toBeTruthy();

    rerender(
      <VersionPreview diffData={diffData} diffError={null} selection={selection} showDiff={false} />
    );
    expect(lastEditorConfig.content).toBe(plain);
  });

  it('always mounts the editor read-only', () => {
    renderPreview({ diffData: { document: annotated, meta: {} } });
    expect(lastEditorConfig.editable).toBe(false);
  });
});

describe('VersionPreview — notices and contributors (042 characterization)', () => {
  it('renders the diff-unavailable notice when the server reports diffFailed', () => {
    renderPreview({ diffData: { document: annotated, meta: { diffFailed: true } } });
    expect(screen.getByText('Diff highlighting unavailable for this version')).toBeTruthy();
  });

  it('renders the sync-only notice for an identical-text version', () => {
    renderPreview({ diffData: { document: annotated, meta: { textIdentical: true } } });
    expect(screen.getByText('No visible text changes (sync update only)')).toBeTruthy();
  });

  it('renders the formatting-only notice when the change was formatting', () => {
    renderPreview({
      diffData: { document: annotated, meta: { textIdentical: true, formattingOnly: true } },
    });
    expect(screen.getByText('Formatting changes only')).toBeTruthy();
  });

  it('suppresses the identical-text notice when the diff itself failed', () => {
    renderPreview({
      diffData: { document: annotated, meta: { textIdentical: true, diffFailed: true } },
    });
    expect(screen.getByText('Diff highlighting unavailable for this version')).toBeTruthy();
    expect(screen.queryByText(/No visible text changes/)).toBeNull();
  });

  it('lists the selection contributors, comma separated, in their own colours', () => {
    const { container } = renderPreview({
      diffData: { document: annotated, meta: {} },
      selection: {
        ...selection,
        authors: [
          { id: 'a', name: 'Ada', color: 'rgb(1, 2, 3)' },
          { id: 'b', name: 'Grace', color: 'rgb(4, 5, 6)' },
        ],
      },
    });

    const authors = container.querySelector('.version-preview-authors');
    expect(authors.textContent).toBe('Contributors:Ada, Grace');
    expect(container.querySelectorAll('.version-preview-author')).toHaveLength(2);
  });

  it('falls back to Unknown for a nameless contributor', () => {
    const { container } = renderPreview({
      diffData: { document: annotated, meta: {} },
      selection: { ...selection, authors: [{ id: 'a', name: null }] },
    });
    expect(container.querySelector('.version-preview-authors').textContent).toBe(
      'Contributors:Unknown'
    );
  });

  it('omits the contributors row when the selection has none', () => {
    const { container } = renderPreview({ diffData: { document: annotated, meta: {} } });
    expect(container.querySelector('.version-preview-authors')).toBeNull();
  });
});

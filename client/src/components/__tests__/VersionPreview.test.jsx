import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import VersionPreview from '../VersionPreview';

// TipTap is irrelevant to the state machine under test; stub it so the preview
// renders synchronously in jsdom. The config is captured so the 043 block below
// can assert WHICH document was handed to the editor — with a mocked editor,
// "the diff document reached the renderer" is the strongest honest claim
// available, and it is the one that catches a preview wired to the wrong field.
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

/**
 * Feature 041 US2 (FR-006, SC-003): a failed preview load renders an error.
 * The "Select a version to preview" placeholder describes exactly one state —
 * nothing is selected — and must never stand in for a failure.
 */
describe('VersionPreview error state (041 FR-006)', () => {
  it('renders an error state when the diff load failed, not the placeholder', () => {
    render(<VersionPreview diffData={null} diffError="diff boom" selection={selection} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Couldn't load this version's preview/i)).toBeTruthy();
    expect(screen.getByText('diff boom')).toBeTruthy();
    expect(screen.queryByText(/Select a version to preview/i)).toBeNull();
  });

  it('renders the placeholder only when nothing is selected', () => {
    render(<VersionPreview diffData={null} diffError={null} selection={null} />);

    expect(screen.getByText(/Select a version to preview/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows loading (never the placeholder) while a selection has no data yet', () => {
    render(<VersionPreview diffData={null} diffError={null} selection={selection} />);

    expect(screen.getByText(/Loading version/i)).toBeTruthy();
    expect(screen.queryByText(/Select a version to preview/i)).toBeNull();
  });

  it('renders the document once the diff arrives', () => {
    render(
      <VersionPreview
        diffData={{ document: { type: 'doc', content: [] }, meta: {} }}
        diffError={null}
        selection={selection}
      />
    );

    expect(screen.getByTestId('editor-content')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Select a version to preview/i)).toBeNull();
  });
});

/**
 * Feature 043 US7 (FR-009, SC-006) — diff-document rendering and the
 * contributor labels.
 *
 * The four US7 coverage areas are split across this file and
 * VersionHistoryPanel.test.jsx. This file owns: diff-document rendering
 * (acceptance scenario 1) and the preview's half of the attribution labels
 * (scenario 3). The error-state area (scenario 4) is already covered by the
 * 041 block above and is not duplicated here.
 *
 * NOTE on what "changed-word emphasis appears in the rendered output" can mean
 * here: `useEditor` is mocked (the real TipTap editor does not render reliably
 * in jsdom, and every sibling suite mocks it the same way), so the marked-up
 * ProseMirror document never becomes DOM. Asserting the mocked EditorContent
 * placeholder would prove nothing about the diff. So these tests assert the
 * document actually handed to the editor — including its diffInsert/diffDelete
 * marks — which is the last point in the client the assertion can be honest
 * about. A regression that dropped the marks, or fed the editor the
 * non-diffed `currentDocument` while `showDiff` was on, fails here.
 */
describe('VersionPreview diff rendering (043 US7, FR-009)', () => {
  /** A diff document carrying both change marks, as the server produces them. */
  const diffDocument = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', text: 'quick', marks: [{ type: 'diffDelete' }] },
          { type: 'text', text: 'swift', marks: [{ type: 'diffInsert' }] },
          { type: 'text', text: ' fox' },
        ],
      },
    ],
  };
  const currentDocument = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The swift fox' }] }],
  };

  beforeEach(() => {
    lastEditorConfig = null;
  });

  it('hands the marked-up diff document to the editor when highlighting is on', () => {
    render(
      <VersionPreview
        diffData={{ document: diffDocument, currentDocument, meta: {} }}
        diffError={null}
        selection={selection}
        showDiff={true}
      />
    );

    expect(screen.getByTestId('editor-content')).toBeTruthy();
    expect(lastEditorConfig.content).toBe(diffDocument);
    expect(lastEditorConfig.editable).toBe(false);

    // The changed words carry their emphasis marks all the way to the editor.
    const marks = lastEditorConfig.content.content[0].content
      .flatMap((node) => (node.marks || []).map((m) => m.type));
    expect(marks).toContain('diffInsert');
    expect(marks).toContain('diffDelete');
  });

  it('hands the UNMARKED current document to the editor when highlighting is off', () => {
    // The inverse of the above: with the toggle off the preview must show the
    // plain version, not the diff. Wiring these two to the same field is the
    // regression this pair catches.
    render(
      <VersionPreview
        diffData={{ document: diffDocument, currentDocument, meta: {} }}
        diffError={null}
        selection={selection}
        showDiff={false}
      />
    );

    expect(lastEditorConfig.content).toBe(currentDocument);
  });

  it('falls back to the diff document when there is no separate current document', () => {
    render(
      <VersionPreview
        diffData={{ document: diffDocument, meta: {} }}
        diffError={null}
        selection={selection}
        showDiff={false}
      />
    );

    expect(lastEditorConfig.content).toBe(diffDocument);
  });

  it('says so when diff highlighting was unavailable, and still renders the content', () => {
    render(
      <VersionPreview
        diffData={{ document: diffDocument, meta: { diffFailed: true } }}
        diffError={null}
        selection={selection}
      />
    );

    expect(screen.getByText('Diff highlighting unavailable for this version')).toBeTruthy();
    expect(screen.getByTestId('editor-content')).toBeTruthy();
    // A failed *highlight* is not a failed *load* — no alert, no error state.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the contributors of the previewed version', () => {
    // Post-040/041 label semantics (ledger D8): the client renders the author
    // names the server resolved. A human is their own name; an agent's name is
    // the agent's, carrying the human it acted for. Nothing here is labelled a
    // restore or an undo target — see the panel suite for that negative.
    const { container } = render(
      <VersionPreview
        diffData={{ document: diffDocument, meta: {} }}
        diffError={null}
        selection={{
          ...selection,
          authors: [
            { id: 'u1', name: 'Ada Lovelace', color: '#112233', isAgent: false },
            { id: 'a1', name: 'Claude (Ada Lovelace)', color: '#445566', isAgent: true },
          ],
        }}
      />
    );

    expect(screen.getByText('Contributors:')).toBeTruthy();
    // Each author is its own span; the ", " separator lives INSIDE the leading
    // span, so read the names off the spans rather than matching whole text.
    const names = [...container.querySelectorAll('.version-preview-author')]
      .map((el) => el.textContent.replace(/,\s*$/, ''));
    expect(names).toEqual(['Ada Lovelace', 'Claude (Ada Lovelace)']);
  });

  it('names an unresolvable author honestly rather than crediting nobody', () => {
    render(
      <VersionPreview
        diffData={{ document: diffDocument, meta: {} }}
        diffError={null}
        selection={{ ...selection, authors: [{ id: 'x', name: 'Synced content', isSynced: true }] }}
      />
    );

    expect(screen.getByText('Synced content')).toBeTruthy();
  });
});

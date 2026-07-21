/**
 * Shared text-path regression corpus for feature 027 (read-only-highlights).
 *
 * Builds a fixed set of TEXT-BEARING document shapes with a deterministic
 * clientID and serializes cursor positions through both public position
 * constructors (createCursorPosition and createCursorPositionFromPath) at
 * several offsets, including past-end offsets that exercise the "clamp to end
 * of last text run" branch.
 *
 * FR-005/SC-004: the 027 fix only changes the TEXT-LESS branch. This corpus
 * contains only text-bearing targets, so re-serializing it after the fix MUST
 * be byte-identical to the pre-fix baseline captured in
 * cursor-textpath-baseline.json. Both the baseline-capture step and the
 * regression test import THIS module so the doc construction is guaranteed
 * identical on both sides of the comparison.
 */

const Y = require('yjs');
const {
  createCursorPosition,
  createCursorPositionFromPath,
} = require('../../yjs/cursor-operations');

// Fixed clientID makes RelativePosition item ids deterministic across runs.
const FIXED_CLIENT_ID = 42;

function newDoc() {
  const doc = new Y.Doc();
  doc.clientID = FIXED_CLIENT_ID;
  return doc;
}

function xmlText(str, attrs) {
  const t = new Y.XmlText();
  if (str) t.insert(0, str, attrs);
  return t;
}

/**
 * Build the corpus and return a flat map of label -> serialized position JSON.
 * Each entry is a plain object (JSON) suitable for stable stringification.
 */
function computeCorpus() {
  const out = {};

  // Case 1: single paragraph with plain text.
  {
    const doc = newDoc();
    const frag = doc.get('default', Y.XmlFragment);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [xmlText('hello world')]);
    frag.insert(0, [para]);
    for (const off of [0, 1, 5, 11, 999]) {
      out[`p1.linear.off${off}`] = createCursorPosition(frag, 0, off);
      out[`p1.path.off${off}`] = createCursorPositionFromPath(frag, [0], off);
    }
  }

  // Case 2: heading with text.
  {
    const doc = newDoc();
    const frag = doc.get('default', Y.XmlFragment);
    const h = new Y.XmlElement('heading');
    h.insert(0, [xmlText('A Heading')]);
    frag.insert(0, [h]);
    for (const off of [0, 4, 9, 500]) {
      out[`h2.linear.off${off}`] = createCursorPosition(frag, 0, off);
      out[`h2.path.off${off}`] = createCursorPositionFromPath(frag, [0], off);
    }
  }

  // Case 3: nested list item (bulletList > listItem > paragraph > text).
  {
    const doc = newDoc();
    const frag = doc.get('default', Y.XmlFragment);
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [xmlText('list entry text')]);
    item.insert(0, [para]);
    list.insert(0, [item]);
    frag.insert(0, [list]);
    for (const off of [0, 3, 15, 400]) {
      // Path navigates list(0) -> item(0) -> paragraph(0).
      out[`li.path.off${off}`] = createCursorPositionFromPath(frag, [0, 0, 0], off);
    }
    // Also the top-level linear addressing of the list block.
    out['li.linear.off0'] = createCursorPosition(frag, 0, 0);
    out['li.linear.past'] = createCursorPosition(frag, 0, 999);
  }

  // Case 4: multi-child block — paragraph with several styled text runs.
  {
    const doc = newDoc();
    const frag = doc.get('default', Y.XmlFragment);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [
      xmlText('bold', { bold: true }),
      xmlText(' plain '),
      xmlText('italic', { italic: true }),
    ]);
    frag.insert(0, [para]);
    // Offsets crossing the run boundaries (4 = end of first run, 11 = into third).
    for (const off of [0, 4, 5, 11, 17, 999]) {
      out[`multi.linear.off${off}`] = createCursorPosition(frag, 0, off);
      out[`multi.path.off${off}`] = createCursorPositionFromPath(frag, [0], off);
    }
  }

  return out;
}

module.exports = { computeCorpus, FIXED_CLIENT_ID };

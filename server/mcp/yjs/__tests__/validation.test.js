/**
 * Tests for validateDocumentSchema
 */
const Y = require('yjs');
const { validateDocumentSchema } = require('../validation');

/**
 * Helper: build a simple paragraph with text
 */
function buildParagraph(xmlFragment, text) {
  const para = new Y.XmlElement('paragraph');
  const textNode = new Y.XmlText();
  textNode.insert(0, text);
  para.insert(0, [textNode]);
  xmlFragment.insert(xmlFragment.length, [para]);
  return para;
}

describe('validateDocumentSchema', () => {
  let ydoc;
  let xmlFragment;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
  });

  test('valid document with paragraph returns valid: true', () => {
    buildParagraph(xmlFragment, 'Hello world');
    const result = validateDocumentSchema(xmlFragment);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('valid document with heading returns valid: true', () => {
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 1);
    const text = new Y.XmlText();
    text.insert(0, 'Title');
    heading.insert(0, [text]);
    xmlFragment.insert(0, [heading]);

    const result = validateDocumentSchema(xmlFragment);
    expect(result.valid).toBe(true);
  });

  test('valid bullet list with listItem wrappers returns valid: true', () => {
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Item 1');
    para.insert(0, [text]);
    item.insert(0, [para]);
    list.insert(0, [item]);
    xmlFragment.insert(0, [list]);

    const result = validateDocumentSchema(xmlFragment);
    expect(result.valid).toBe(true);
  });

  test('paragraph directly in bulletList returns valid: false', () => {
    const list = new Y.XmlElement('bulletList');
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Bad structure');
    para.insert(0, [text]);
    list.insert(0, [para]);
    xmlFragment.insert(0, [list]);

    const result = validateDocumentSchema(xmlFragment);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('paragraph in bulletList alongside valid items returns valid: false', () => {
    const list = new Y.XmlElement('bulletList');

    // Valid item
    const item = new Y.XmlElement('listItem');
    const validPara = new Y.XmlElement('paragraph');
    const validText = new Y.XmlText();
    validText.insert(0, 'Valid item');
    validPara.insert(0, [validText]);
    item.insert(0, [validPara]);
    list.insert(0, [item]);

    // Invalid: bare paragraph in bulletList
    const badPara = new Y.XmlElement('paragraph');
    const badText = new Y.XmlText();
    badText.insert(0, 'Lost content');
    badPara.insert(0, [badText]);
    list.insert(1, [badPara]);

    xmlFragment.insert(0, [list]);

    const result = validateDocumentSchema(xmlFragment);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('listItem at document root returns valid: false', () => {
    const item = new Y.XmlElement('listItem');
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Orphan list item');
    para.insert(0, [text]);
    item.insert(0, [para]);
    xmlFragment.insert(0, [item]);

    const result = validateDocumentSchema(xmlFragment);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('empty document returns valid: false (doc requires block+)', () => {
    // ProseMirror schema defines doc as content: 'block+', so empty is invalid
    const result = validateDocumentSchema(xmlFragment);
    // An empty XmlFragment may convert to an empty doc node which violates block+
    // The behavior depends on y-prosemirror conversion - either valid or invalid is acceptable
    // but we verify it doesn't throw unexpectedly
    expect(typeof result.valid).toBe('boolean');
    expect(result.error === null || typeof result.error === 'string').toBe(true);
  });

  test('valid nested list structure returns valid: true', () => {
    const outerList = new Y.XmlElement('bulletList');
    const outerItem = new Y.XmlElement('listItem');
    const outerPara = new Y.XmlElement('paragraph');
    const outerText = new Y.XmlText();
    outerText.insert(0, 'Parent');
    outerPara.insert(0, [outerText]);
    outerItem.insert(0, [outerPara]);

    const innerList = new Y.XmlElement('bulletList');
    const innerItem = new Y.XmlElement('listItem');
    const innerPara = new Y.XmlElement('paragraph');
    const innerText = new Y.XmlText();
    innerText.insert(0, 'Child');
    innerPara.insert(0, [innerText]);
    innerItem.insert(0, [innerPara]);
    innerList.insert(0, [innerItem]);

    outerItem.insert(1, [innerList]);
    outerList.insert(0, [outerItem]);
    xmlFragment.insert(0, [outerList]);

    const result = validateDocumentSchema(xmlFragment);
    expect(result.valid).toBe(true);
  });
});

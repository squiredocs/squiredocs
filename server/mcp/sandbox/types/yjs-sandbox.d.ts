/**
 * TypeScript definitions for Yjs API available in sandbox scripts
 *
 * This file provides type definitions for scripts that manipulate Yjs documents.
 * Scripts receive a Y.XmlFragment representing the TipTap document and can use
 * standard Yjs operations to read and modify the document structure.
 */

/**
 * Delta format for text with attributes (marks/formatting)
 */
export interface Delta {
  insert: string;
  attributes?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    link?: string;
    [key: string]: any;
  };
}

/**
 * Yjs namespace - contains all Yjs types available in the sandbox
 */
export namespace Y {
  /**
   * XmlFragment - represents the document root or a container of blocks
   */
  export class XmlFragment {
    /**
     * Number of child nodes
     */
    readonly length: number;

    /**
     * Get all child nodes as an array
     */
    toArray(): (XmlElement | XmlText)[];

    /**
     * Insert elements at a specific position
     * @param index - Position to insert at (0-based)
     * @param content - Array of XmlElement or XmlText nodes to insert
     */
    insert(index: number, content: (XmlElement | XmlText)[]): void;

    /**
     * Delete elements from a specific position
     * @param index - Starting position (0-based)
     * @param length - Number of elements to delete
     */
    delete(index: number, length: number): void;

    /**
     * Get a child element at a specific index
     * @param index - Position (0-based)
     */
    get(index: number): XmlElement | XmlText | undefined;

    /**
     * Iterate over child nodes
     */
    [Symbol.iterator](): Iterator<XmlElement | XmlText>;
  }

  /**
   * XmlElement - represents a block element (paragraph, heading, list, etc.)
   */
  export class XmlElement {
    /**
     * Element type name (e.g., 'paragraph', 'heading', 'bulletList')
     */
    readonly nodeName: string;

    /**
     * Number of child nodes
     */
    readonly length: number;

    /**
     * Get an attribute value
     * @param name - Attribute name
     */
    getAttribute(name: string): any;

    /**
     * Set an attribute value
     * @param name - Attribute name
     * @param value - Attribute value
     */
    setAttribute(name: string, value: any): void;

    /**
     * Remove an attribute
     * @param name - Attribute name
     */
    removeAttribute(name: string): void;

    /**
     * Get all attributes as an object
     */
    getAttributes(): { [key: string]: any };

    /**
     * Get all child nodes as an array
     */
    toArray(): (XmlElement | XmlText)[];

    /**
     * Insert child elements at a specific position
     * @param index - Position to insert at (0-based)
     * @param content - Array of XmlElement or XmlText nodes to insert
     */
    insert(index: number, content: (XmlElement | XmlText)[]): void;

    /**
     * Delete child elements from a specific position
     * @param index - Starting position (0-based)
     * @param length - Number of elements to delete
     */
    delete(index: number, length: number): void;

    /**
     * Get a child element at a specific index
     * @param index - Position (0-based)
     */
    get(index: number): XmlElement | XmlText | undefined;

    /**
     * Push elements to the end
     * @param content - Array of XmlElement or XmlText nodes to push
     */
    push(content: (XmlElement | XmlText)[]): void;

    /**
     * Get first child node
     */
    get firstChild(): XmlElement | XmlText | null;

    /**
     * Iterate over child nodes
     */
    [Symbol.iterator](): Iterator<XmlElement | XmlText>;

    /**
     * Clone this element
     */
    clone(): XmlElement;
  }

  /**
   * XmlText - represents text content with optional formatting (marks)
   */
  export class XmlText {
    /**
     * Length of text content (number of characters)
     */
    readonly length: number;

    /**
     * Convert to plain text string
     * WARNING: Returns XML markup if text has formatting. Use toDelta() instead.
     */
    toString(): string;

    /**
     * Convert to Delta format (array of text segments with attributes)
     * This is the recommended way to extract text content.
     */
    toDelta(): Delta[];

    /**
     * Insert text at a specific position
     * @param offset - Character position (0-based)
     * @param text - Text to insert
     * @param attributes - Optional formatting attributes (bold, italic, etc.)
     */
    insert(offset: number, text: string, attributes?: { [key: string]: any }): void;

    /**
     * Delete text from a specific position
     * @param offset - Starting character position (0-based)
     * @param length - Number of characters to delete
     */
    delete(offset: number, length: number): void;

    /**
     * Apply formatting to a range of text
     * @param offset - Starting character position (0-based)
     * @param length - Number of characters to format
     * @param attributes - Formatting attributes to apply (bold, italic, etc.)
     */
    format(offset: number, length: number, attributes: { [key: string]: any }): void;

    /**
     * Clone this text node
     */
    clone(): XmlText;
  }
}

/**
 * Script entry point
 * Scripts must export a default function that receives the document fragment
 *
 * @example
 * export default function edit(doc: Y.XmlFragment) {
 *   // Your editing logic here
 *   const blocks = doc.toArray();
 *   // ...
 * }
 */
export default function edit(doc: Y.XmlFragment): void;

/**
 * XPath support for Yjs documents using fontoxpath
 *
 * Provides a custom domFacade that bridges fontoxpath's DOM expectations
 * to Yjs's XmlFragment/XmlElement/XmlText API.
 *
 * Supported XPath features:
 * - Descendant selection: //heading, //paragraph
 * - Attribute predicates: [@level=2], [@level]
 * - Text predicates: [contains(., "TODO")]
 * - Child axis: child::*
 * - Descendant axis: descendant::*
 * - Following-sibling axis: following-sibling::*
 * - Preceding-sibling axis: preceding-sibling::*
 *
 * Limitations (due to Yjs not exposing parent references):
 * - parent:: axis not supported
 * - ancestor:: axis not supported
 */

const { evaluateXPathToNodes, evaluateXPathToFirstNode } = require('fontoxpath');
const Y = require('yjs');

/**
 * Cache mapping child nodes to their parent nodes.
 * Populated during getChildren() traversal, used to rebuild parent chains
 * when a node from a previous xpath result is passed as context.
 * WeakMap ensures entries are garbage collected when nodes are no longer referenced.
 */
const parentCache = new WeakMap();

/**
 * Wrapper that adds DOM-like properties to Yjs nodes
 * Tracks parent reference for sibling navigation
 */
class YjsNodeWrapper {
  constructor(yjsNode, parent = null) {
    this._yjs = yjsNode;
    this._parent = parent;
    this._childrenCache = null;

    // DOM node type constants
    // NOTE: Check XmlElement BEFORE XmlFragment because XmlElement extends XmlFragment
    if (yjsNode instanceof Y.XmlText) {
      this.nodeType = 3; // TEXT_NODE
      this.nodeName = '#text';
      this.localName = null;
    } else if (yjsNode instanceof Y.XmlElement) {
      this.nodeType = 1; // ELEMENT_NODE
      this.nodeName = yjsNode.nodeName;
      this.localName = yjsNode.nodeName;
    } else if (yjsNode instanceof Y.XmlFragment) {
      this.nodeType = 9; // DOCUMENT_NODE
      this.nodeName = '#document';
      this.localName = null;
    } else {
      // Unknown type
      this.nodeType = 1;
      this.nodeName = 'unknown';
      this.localName = 'unknown';
    }

    this.namespaceURI = null;
    this.prefix = null;
  }

  /**
   * Get wrapped children (cached)
   */
  getChildren() {
    if (this._childrenCache === null) {
      const yjsNode = this._yjs;
      if (yjsNode && typeof yjsNode.toArray === 'function') {
        this._childrenCache = yjsNode.toArray().map(child => {
          // Cache parent relationship so we can rebuild the chain later
          // when this child is passed as context to a subsequent xpath call
          parentCache.set(child, yjsNode);
          return new YjsNodeWrapper(child, this);
        });
      } else {
        this._childrenCache = [];
      }
    }
    return this._childrenCache;
  }

  /**
   * Get the original Yjs node
   */
  unwrap() {
    return this._yjs;
  }
}

/**
 * DomFacade implementation for fontoxpath that works with YjsNodeWrapper
 */
const yjsDomFacade = {
  /**
   * Get all attributes from an element
   */
  getAllAttributes(node) {
    const yjsNode = node._yjs || node;
    if (!(yjsNode instanceof Y.XmlElement)) {
      return [];
    }
    const attrs = yjsNode.getAttributes();
    return Object.entries(attrs).map(([name, value]) => ({
      nodeType: 2, // ATTRIBUTE_NODE
      nodeName: name,
      localName: name,
      namespaceURI: null,
      prefix: null,
      value: String(value),
      // Store value for getData
      _attrValue: String(value),
    }));
  },

  /**
   * Get a specific attribute value
   */
  getAttribute(node, attributeName) {
    const yjsNode = node._yjs || node;
    if (yjsNode instanceof Y.XmlElement && yjsNode.getAttribute) {
      const value = yjsNode.getAttribute(attributeName);
      return value !== undefined ? String(value) : null;
    }
    return null;
  },

  /**
   * Get all child nodes
   */
  getChildNodes(node) {
    if (node instanceof YjsNodeWrapper) {
      return node.getChildren();
    }
    // Fallback for unwrapped nodes
    const yjsNode = node._yjs || node;
    if (yjsNode && typeof yjsNode.toArray === 'function') {
      return yjsNode.toArray().map(child => new YjsNodeWrapper(child, node));
    }
    return [];
  },

  /**
   * Get text data from a text node or attribute
   */
  getData(node) {
    // Handle attribute nodes (from getAllAttributes)
    if (node.nodeType === 2 && node._attrValue !== undefined) {
      return node._attrValue;
    }

    const yjsNode = node._yjs || node;
    if (yjsNode instanceof Y.XmlText) {
      // Use toDelta to get plain text (avoids XML markup issue with toString())
      const delta = yjsNode.toDelta();
      return delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
    }
    return '';
  },

  /**
   * Get first child node
   */
  getFirstChild(node) {
    const children = this.getChildNodes(node);
    return children.length > 0 ? children[0] : null;
  },

  /**
   * Get last child node
   */
  getLastChild(node) {
    const children = this.getChildNodes(node);
    return children.length > 0 ? children[children.length - 1] : null;
  },

  /**
   * Get next sibling
   */
  getNextSibling(node) {
    if (!(node instanceof YjsNodeWrapper) || !node._parent) {
      return null;
    }
    const siblings = node._parent.getChildren();
    const idx = siblings.indexOf(node);
    return idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  },

  /**
   * Get previous sibling
   */
  getPreviousSibling(node) {
    if (!(node instanceof YjsNodeWrapper) || !node._parent) {
      return null;
    }
    const siblings = node._parent.getChildren();
    const idx = siblings.indexOf(node);
    return idx > 0 ? siblings[idx - 1] : null;
  },

  /**
   * Get parent node
   */
  getParentNode(node) {
    if (node instanceof YjsNodeWrapper) {
      return node._parent || null;
    }
    return null;
  },
};

/**
 * Create a YjsNodeWrapper for a context node, rebuilding the parent chain
 * from the parentCache so that sibling axes work correctly.
 *
 * @param {*} yjsNode - The Yjs node (or proxy) to wrap
 * @returns {YjsNodeWrapper} Wrapper with parent chain reconstructed
 */
function createContextWrapper(yjsNode) {
  // Check if we have a cached parent for this node
  const parentYjsNode = parentCache.get(yjsNode);

  if (!parentYjsNode) {
    // No parent cached - this is either the root or a node we haven't traversed
    return new YjsNodeWrapper(yjsNode);
  }

  // Recursively create wrapper for parent (building the chain up to root)
  const parentWrapper = createContextWrapper(parentYjsNode);

  // Get children from parent - this returns cached wrappers with _parent set
  const children = parentWrapper.getChildren();

  // Find this node among the children
  const wrapper = children.find(child => child._yjs === yjsNode);

  // Return the found wrapper (with _parent set) or fallback to orphan wrapper
  return wrapper || new YjsNodeWrapper(yjsNode);
}

/**
 * Execute XPath query and return all matching nodes
 *
 * @param {string} expression - XPath expression (e.g., '//heading[@level=2]')
 * @param {Y.XmlFragment|Y.XmlElement} contextNode - Node to query from (Yjs node or wrapper)
 * @returns {Array} Array of matching Yjs nodes (unwrapped)
 *
 * @example
 *   // Find all headings
 *   const headings = xpath('//heading', doc);
 *
 *   // Find level-2 headings
 *   const h2s = xpath('//heading[@level=2]', doc);
 *
 *   // Find elements containing specific text
 *   const todos = xpath('//paragraph[contains(., "TODO")]', doc);
 *
 *   // Find sibling after a heading
 *   const lists = xpath('//heading[contains(., "Items")]/following-sibling::bulletList[1]', doc);
 */
function xpath(expression, contextNode) {
  // Wrap the context node, rebuilding parent chain from cache if available
  const wrappedContext = contextNode instanceof YjsNodeWrapper
    ? contextNode
    : createContextWrapper(contextNode);

  const results = evaluateXPathToNodes(expression, wrappedContext, yjsDomFacade);

  // Unwrap results back to original Yjs nodes
  return results.map(node => {
    if (node instanceof YjsNodeWrapper) {
      return node.unwrap();
    }
    if (node._yjs) {
      return node._yjs;
    }
    return node;
  });
}

/**
 * Execute XPath query and return the first matching node
 *
 * @param {string} expression - XPath expression
 * @param {Y.XmlFragment|Y.XmlElement} contextNode - Node to query from
 * @returns {*|null} First matching Yjs node (unwrapped) or null
 *
 * @example
 *   const firstHeading = xpathFirst('//heading', doc);
 *   if (firstHeading) {
 *     const text = findTextNode(firstHeading);
 *     // ...
 *   }
 */
function xpathFirst(expression, contextNode) {
  // Wrap the context node, rebuilding parent chain from cache if available
  const wrappedContext = contextNode instanceof YjsNodeWrapper
    ? contextNode
    : createContextWrapper(contextNode);

  const result = evaluateXPathToFirstNode(expression, wrappedContext, yjsDomFacade);

  if (!result) return null;

  // Unwrap back to original Yjs node
  if (result instanceof YjsNodeWrapper) {
    return result.unwrap();
  }
  if (result._yjs) {
    return result._yjs;
  }
  return result;
}

module.exports = {
  xpath,
  xpathFirst,
  YjsNodeWrapper,
  yjsDomFacade,
  createContextWrapper,
};

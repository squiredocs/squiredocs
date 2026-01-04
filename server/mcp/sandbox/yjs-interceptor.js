/**
 * Yjs operation interceptor
 * Wraps Yjs objects (XmlFragment, XmlElement, XmlText) with Proxy to track mutations
 */

const Y = require('yjs');

/**
 * Wraps a Yjs object to track all mutation operations
 * @param {Y.XmlFragment | Y.XmlElement | Y.XmlText} yjsObject - Yjs object to wrap
 * @param {object} tracker - Operation tracker to record operations
 * @param {Array<number>} path - Current path in document tree (e.g., [0, 1] for second child of first block)
 * @param {Function} [onOperation] - Optional callback called when an operation is recorded
 * @returns {Proxy} - Wrapped object with operation tracking
 */
function wrapForTracking(yjsObject, tracker, path = [], onOperation = null) {
  // Track wrapped objects to avoid double-wrapping
  if (yjsObject.__wrapped) {
    return yjsObject;
  }

  const handler = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);

      // Handle methods that mutate or read the document
      if (typeof value === 'function') {
        return function(...args) {
          const result = value.apply(target, args);

          // Record mutation operations
          if (isMutationMethod(prop)) {
            const operation = {
              type: prop,
              category: 'mutation',
              target: getTargetType(target),
              path: [...path],
              args: [...args],
              timestamp: Date.now(),
            };
            tracker.record(operation);
            if (onOperation) {
              onOperation(operation, target);
            }
          }

          // Record read operations
          if (isReadMethod(prop)) {
            const operation = {
              type: prop,
              category: 'read',
              target: getTargetType(target),
              path: [...path],
              args: [...args],
              timestamp: Date.now(),
            };
            tracker.record(operation);
            if (onOperation) {
              onOperation(operation, target);
            }
          }

          // If result is a Yjs object, wrap it recursively
          if (isYjsObject(result)) {
            return wrapForTracking(result, tracker, path, onOperation);
          }

          // If method returns an array, wrap any Yjs objects in it
          if (Array.isArray(result)) {
            return result.map((item, index) => {
              if (isYjsObject(item)) {
                return wrapForTracking(item, tracker, [...path, index], onOperation);
              }
              return item;
            });
          }

          return result;
        };
      }

      // If accessing a property that is a Yjs object, wrap it recursively
      if (isYjsObject(value)) {
        // For indexed access (e.g., doc[0]), include index in path
        if (typeof prop === 'string' && !isNaN(Number(prop))) {
          return wrapForTracking(value, tracker, [...path, Number(prop)], onOperation);
        }
        return wrapForTracking(value, tracker, path, onOperation);
      }

      return value;
    },

    // Support iteration
    has(target, prop) {
      return Reflect.has(target, prop);
    },

    ownKeys(target) {
      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  };

  const proxy = new Proxy(yjsObject, handler);

  // Mark as wrapped to avoid double-wrapping
  Object.defineProperty(proxy, '__wrapped', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  return proxy;
}

/**
 * Checks if a method is a mutation operation
 * @param {string} methodName - Method name
 * @returns {boolean}
 */
function isMutationMethod(methodName) {
  const mutationMethods = [
    // XmlFragment/XmlElement mutations
    'insert',
    'delete',
    'push',
    'unshift',

    // XmlElement attribute mutations
    'setAttribute',
    'removeAttribute',

    // XmlText mutations
    'format',
  ];

  return mutationMethods.includes(methodName);
}

/**
 * Checks if a method is a read operation
 * @param {string} methodName - Method name
 * @returns {boolean}
 */
function isReadMethod(methodName) {
  const readMethods = [
    // XmlFragment/XmlElement read operations
    'get',
    'toArray',
    'toJSON',
    'clone',
    'slice',

    // XmlElement attribute reads
    'getAttribute',
    'getAttributes',
    'hasAttribute',

    // XmlText read operations
    'toDelta',
    'toString',
    'toDOM',

    // Common accessors
    'firstChild',
    'length',
  ];

  return readMethods.includes(methodName);
}

/**
 * Checks if a value is a Yjs object
 * @param {any} value - Value to check
 * @returns {boolean}
 */
function isYjsObject(value) {
  return (
    value instanceof Y.XmlFragment ||
    value instanceof Y.XmlElement ||
    value instanceof Y.XmlText
  );
}

/**
 * Gets the type name of a Yjs object
 * @param {Y.XmlFragment | Y.XmlElement | Y.XmlText} target - Yjs object
 * @returns {string}
 */
function getTargetType(target) {
  if (target instanceof Y.XmlFragment) {
    return 'XmlFragment';
  }
  if (target instanceof Y.XmlElement) {
    return target.nodeName || 'XmlElement';
  }
  if (target instanceof Y.XmlText) {
    return 'XmlText';
  }
  return 'Unknown';
}

module.exports = { wrapForTracking };

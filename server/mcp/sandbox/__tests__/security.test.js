/**
 * Security tests for isolated-vm sandbox
 * Verifies that the prototype chain escape and other attack vectors are blocked.
 */
const { executeSandboxed } = require('../executor');
const Y = require('yjs');

function createSnapshot(setupFn) {
  const ydoc = new Y.Doc();
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  if (setupFn) setupFn(xmlFragment);
  return Y.encodeStateAsUpdate(ydoc);
}

function runScript(jsCode, snapshot) {
  if (!snapshot) snapshot = createSnapshot();
  return executeSandboxed(jsCode, snapshot, 5000, () => {}, () => {});
}

describe('Sandbox security (isolated-vm)', () => {
  test('process is not accessible', () => {
    const jsCode = `
      exports.default = function(doc) {
        if (typeof process !== 'undefined') {
          throw new Error('process should not be accessible');
        }
      };
    `;
    // Should NOT throw — process is undefined in the isolate
    expect(() => runScript(jsCode)).not.toThrow();
  });

  test('require is not accessible', () => {
    const jsCode = `
      exports.default = function(doc) {
        require('fs');
      };
    `;
    expect(() => runScript(jsCode)).toThrow();
  });

  test('global/globalThis has no Node.js APIs', () => {
    const jsCode = `
      exports.default = function(doc) {
        const forbidden = ['process', 'require', 'Buffer', '__filename', '__dirname'];
        for (const name of forbidden) {
          if (typeof globalThis[name] !== 'undefined') {
            throw new Error(name + ' should not be accessible but was ' + typeof globalThis[name]);
          }
        }
      };
    `;
    expect(() => runScript(jsCode)).not.toThrow();
  });

  test('prototype chain escape gives ReferenceError, not process access', () => {
    const snapshot = createSnapshot((frag) => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'test');
      para.insert(0, [text]);
      frag.insert(0, [para]);
    });

    const jsCode = `
      exports.default = function(doc) {
        // Classic vm.createContext escape — should fail in isolated-vm
        const Func = doc.constructor.constructor;
        const proc = Func('return process')();
        proc.exit(1);
      };
    `;

    // Should throw ReferenceError (process not defined), NOT give access to process
    expect(() => runScript(jsCode, snapshot)).toThrow();
  });

  test('Function constructor cannot access Node.js globals', () => {
    const jsCode = `
      exports.default = function(doc) {
        const F = (function(){}).constructor;
        const result = F('return typeof process')();
        if (result !== 'undefined') {
          throw new Error('Function constructor should not have access to process, got: ' + result);
        }
      };
    `;
    expect(() => runScript(jsCode)).not.toThrow();
  });

  test('setTimeout is a no-op (does not actually schedule)', () => {
    const jsCode = `
      exports.default = function(doc) {
        // setTimeout exists as a no-op polyfill for lib0 compatibility
        // but it does not actually schedule anything
        let called = false;
        setTimeout(function() { called = true; }, 0);
        if (called) {
          throw new Error('setTimeout should not actually execute callbacks');
        }
      };
    `;
    expect(() => runScript(jsCode)).not.toThrow();
  });

  test('infinite loop is terminated by timeout', () => {
    const jsCode = `
      exports.default = function(doc) {
        while (true) {}
      };
    `;
    expect(() => runScript(jsCode, createSnapshot())).toThrow(/timed out/i);
  }, 10000);
});

/**
 * Tests for TypeScript compiler
 */
const { compileTypeScript } = require('../compiler');

describe('TypeScript compiler', () => {
  describe('compileTypeScript', () => {
    test('compiles valid TypeScript code', () => {
      const tsCode = `
        export default function edit(doc: any) {
          const blocks = doc.toArray();
        }
      `;

      const jsCode = compileTypeScript(tsCode);

      expect(jsCode).toBeTruthy();
      expect(jsCode).toContain('function edit');
      expect(jsCode).toContain('toArray');
      // Type annotations should be removed
      expect(jsCode).not.toContain(': any');
    });

    test('compiles TypeScript with type annotations', () => {
      const tsCode = `
        interface Block {
          nodeName: string;
        }

        export default function edit(doc: any) {
          const block: Block = { nodeName: 'paragraph' };
        }
      `;

      const jsCode = compileTypeScript(tsCode);

      expect(jsCode).toBeTruthy();
      expect(jsCode).toContain('nodeName');
      // Interface should be removed
      expect(jsCode).not.toContain('interface');
      expect(jsCode).not.toContain(': Block');
    });

    test('compiles modern JavaScript features', () => {
      const tsCode = `
        export default function edit(doc: any) {
          const items = [1, 2, 3];
          const doubled = items.map(x => x * 2);
          const { nodeName } = doc.get(0);
        }
      `;

      const jsCode = compileTypeScript(tsCode);

      expect(jsCode).toBeTruthy();
      expect(jsCode).toContain('map');
      expect(jsCode).toContain('=>');
    });

    test('throws error for invalid TypeScript', () => {
      const tsCode = `
        export default function edit(doc: any) {
          const x = ;
        }
      `;

      expect(() => compileTypeScript(tsCode)).toThrow(/compilation failed/i);
    });

    test('throws error for syntax errors', () => {
      const tsCode = `
        export default function edit(doc: any {
          // Missing closing parenthesis
        }
      `;

      expect(() => compileTypeScript(tsCode)).toThrow(/compilation failed/i);
    });

    test('preserves function names for error messages', () => {
      const tsCode = `
        function myHelper() {
          return 42;
        }

        export default function edit(doc: any) {
          myHelper();
        }
      `;

      const jsCode = compileTypeScript(tsCode);

      expect(jsCode).toBeTruthy();
      expect(jsCode).toContain('myHelper');
    });

    test('compiles empty function', () => {
      const tsCode = `
        export default function edit(doc: any) {
          // Empty function
        }
      `;

      const jsCode = compileTypeScript(tsCode);

      expect(jsCode).toBeTruthy();
      expect(jsCode).toContain('function edit');
    });
  });
});

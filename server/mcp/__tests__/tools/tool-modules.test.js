/**
 * Tool Module Smoke Tests
 *
 * These tests ensure all tool modules:
 * 1. Can be loaded without syntax errors
 * 2. Export the required properties (name, description, inputSchema, handler, init)
 * 3. Have valid schemas and descriptions
 *
 * This catches issues like:
 * - Syntax errors in template literals
 * - Missing required exports
 * - Invalid JSON schemas
 */

describe('Tool Module Smoke Tests', () => {
  // List of all tool modules
  const toolModules = [
    // Document management
    'list-documents',
    'create-document',
    'share-document',
    'set-document-title',

    // Session and reading tools
    'read-document',
    'get-collaborators',
    'undo',
    'redo',

    // Document modification
    'modify',
  ];

  describe('Module Loading', () => {
    toolModules.forEach((moduleName) => {
      test(`${moduleName} loads without syntax errors`, () => {
        expect(() => {
          require(`../../tools/${moduleName}`);
        }).not.toThrow();
      });
    });
  });

  describe('Required Exports', () => {
    toolModules.forEach((moduleName) => {
      describe(moduleName, () => {
        let toolModule;

        beforeAll(() => {
          toolModule = require(`../../tools/${moduleName}`);
        });

        test('exports name', () => {
          expect(toolModule.name).toBeDefined();
          expect(typeof toolModule.name).toBe('string');
          expect(toolModule.name.length).toBeGreaterThan(0);
        });

        test('exports description', () => {
          expect(toolModule.description).toBeDefined();
          expect(typeof toolModule.description).toBe('string');
          expect(toolModule.description.length).toBeGreaterThan(0);
        });

        test('exports inputSchema', () => {
          expect(toolModule.inputSchema).toBeDefined();
          expect(typeof toolModule.inputSchema).toBe('object');
          expect(toolModule.inputSchema.type).toBe('object');
          expect(toolModule.inputSchema.properties).toBeDefined();
        });

        test('exports handler function', () => {
          expect(toolModule.handler).toBeDefined();
          expect(typeof toolModule.handler).toBe('function');
        });

        test('exports init function', () => {
          expect(toolModule.init).toBeDefined();
          expect(typeof toolModule.init).toBe('function');
        });
      });
    });
  });

  describe('Schema Validation', () => {
    toolModules.forEach((moduleName) => {
      test(`${moduleName} has valid inputSchema`, () => {
        const toolModule = require(`../../tools/${moduleName}`);
        const schema = toolModule.inputSchema;

        // Basic schema structure
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        expect(typeof schema.properties).toBe('object');

        // If required is present, it should be an array
        if (schema.required) {
          expect(Array.isArray(schema.required)).toBe(true);
          // Each required field should exist in properties
          schema.required.forEach((field) => {
            expect(schema.properties[field]).toBeDefined();
          });
        }

        // All properties should have a type or oneOf/anyOf
        Object.keys(schema.properties).forEach((propName) => {
          const prop = schema.properties[propName];
          const hasType = prop.type !== undefined;
          const hasOneOf = prop.oneOf !== undefined;
          const hasAnyOf = prop.anyOf !== undefined;
          expect(hasType || hasOneOf || hasAnyOf).toBe(true);
        });
      });
    });
  });

  describe('Description Quality', () => {
    toolModules.forEach((moduleName) => {
      test(`${moduleName} has substantive description`, () => {
        const toolModule = require(`../../tools/${moduleName}`);
        const description = toolModule.description;

        // Description should be meaningful (more than just a title)
        expect(description.length).toBeGreaterThan(50);

        // Should not have obvious placeholder text (e.g., "TODO:", "FIXME:")
        // Note: "todo" and "fixme" in examples are fine, we're checking for actual placeholders
        expect(description).not.toMatch(/TODO:/i);
        expect(description).not.toMatch(/FIXME:/i);
      });
    });
  });

  describe('Tool Name Consistency', () => {
    toolModules.forEach((moduleName) => {
      test(`${moduleName} exports consistent name`, () => {
        const toolModule = require(`../../tools/${moduleName}`);
        // Convert module filename to expected tool name (hyphen to underscore)
        const expectedName = moduleName.replace(/-/g, '_');
        expect(toolModule.name).toBe(expectedName);
      });
    });
  });

  describe('Handler Function Signature', () => {
    toolModules.forEach((moduleName) => {
      test(`${moduleName} handler accepts correct parameters`, () => {
        const toolModule = require(`../../tools/${moduleName}`);
        // Handler should accept 2 parameters: args and agentToken
        expect(toolModule.handler.length).toBe(2);
      });
    });
  });

  describe('Init Function', () => {
    toolModules.forEach((moduleName) => {
      test(`${moduleName} init function can be called`, () => {
        const toolModule = require(`../../tools/${moduleName}`);
        // Init should accept a persistence provider (or be callable without crashing)
        expect(() => {
          toolModule.init(null);
        }).not.toThrow();
      });
    });
  });
});

describe('Tool Registry Integration', () => {
  test('all tool modules are registered in index.js', () => {
    const toolRegistry = require('../../tools/index');
    const toolList = toolRegistry.getToolList();

    // Expected tool names
    const expectedTools = [
      // Document management
      'list_documents',
      'create_document',
      'share_document',
      'set_document_title',
      // Session and reading tools
      'read_document',
      'get_collaborators',
      'undo',
      'redo',
      // Document modification
      'modify',
      // Version history tools
      'list_document_versions',
      'read_document_version',
      'set_document_version_name',
      'restore_document_version',
    ];

    // Check each tool is registered
    expectedTools.forEach((toolName) => {
      const tool = toolList.find((t) => t.name === toolName);
      expect(tool).toBeDefined();
      expect(tool.name).toBe(toolName);
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
    });

    // Check we have exactly the expected number of tools
    expect(toolList.length).toBe(expectedTools.length);
  });

  test('getTool returns correct tool module', () => {
    const toolRegistry = require('../../tools/index');

    // Test document management tool
    const createTool = toolRegistry.getTool('create_document');
    expect(createTool).toBeDefined();
    expect(createTool.name).toBe('create_document');

    // Test reading tool
    const readTool = toolRegistry.getTool('read_document');
    expect(readTool).toBeDefined();
    expect(readTool.name).toBe('read_document');

    // Test document modification tool
    const modifyTool = toolRegistry.getTool('modify');
    expect(modifyTool).toBeDefined();
    expect(modifyTool.name).toBe('modify');
  });

  test('getTool returns null for unknown tool', () => {
    const toolRegistry = require('../../tools/index');
    const unknownTool = toolRegistry.getTool('unknown_tool_name');
    expect(unknownTool).toBeNull();
  });
});

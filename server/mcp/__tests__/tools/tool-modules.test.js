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
    'list-documents',
    'create-document',
    'share-document',
    'set-document-title',
    'get-document-structure',
    'get-document-schema',
    'read-document-blocks',
    'select-text-range',
    'insert-document-blocks',
    'delete-document-blocks',
    'replace-document-blocks',
    'batch-update-blocks',
    'convert-block-type',
    'bulk-replace-pattern',
    'replace-text',
    'insert-text',
    'delete-text',
    'apply-marks',
    'search-document',
    'get-document-text',
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

        // Should not have obvious placeholder text
        expect(description.toLowerCase()).not.toContain('todo');
        expect(description.toLowerCase()).not.toContain('fixme');
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
      'list_documents',
      'create_document',
      'share_document',
      'set_document_title',
      'get_document_structure',
      'get_document_schema',
      'read_document_blocks',
      'select_text_range',
      'insert_document_blocks',
      'delete_document_blocks',
      'replace_document_blocks',
      'batch_update_blocks',
      'convert_block_type',
      'bulk_replace_pattern',
      'replace_text',
      'insert_text',
      'delete_text',
      'apply_marks',
      'search_document',
      'get_document_text',
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

    // Test a few tools
    const batchTool = toolRegistry.getTool('batch_update_blocks');
    expect(batchTool).toBeDefined();
    expect(batchTool.name).toBe('batch_update_blocks');

    const convertTool = toolRegistry.getTool('convert_block_type');
    expect(convertTool).toBeDefined();
    expect(convertTool.name).toBe('convert_block_type');

    const bulkTool = toolRegistry.getTool('bulk_replace_pattern');
    expect(bulkTool).toBeDefined();
    expect(bulkTool.name).toBe('bulk_replace_pattern');
  });

  test('getTool returns null for unknown tool', () => {
    const toolRegistry = require('../../tools/index');
    const unknownTool = toolRegistry.getTool('unknown_tool_name');
    expect(unknownTool).toBeNull();
  });
});

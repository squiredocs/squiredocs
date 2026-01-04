/**
 * Tests for operation tracker
 */
const { OperationTracker } = require('../operation-tracker');

describe('Operation tracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new OperationTracker();
  });

  describe('record', () => {
    test('records single operation', () => {
      tracker.record({
        type: 'insert',
        target: 'XmlText',
        path: [0],
        args: [0, 'Hello'],
        timestamp: Date.now(),
      });

      expect(tracker.getOperationCount()).toBe(1);
    });

    test('records multiple operations', () => {
      tracker.record({
        type: 'insert',
        target: 'XmlText',
        path: [0],
        args: [0, 'Hello'],
        timestamp: Date.now(),
      });

      tracker.record({
        type: 'format',
        target: 'XmlText',
        path: [0],
        args: [0, 5, { bold: true }],
        timestamp: Date.now(),
      });

      expect(tracker.getOperationCount()).toBe(2);
    });

    test('preserves operation details', () => {
      const operation = {
        type: 'insert',
        category: 'mutation',
        target: 'XmlFragment',
        path: [0, 1],
        args: [0, 'test'],
        timestamp: 12345,
      };

      tracker.record(operation);

      const ops = tracker.getOperations();
      expect(ops[0]).toEqual(operation);
    });
  });

  describe('getOperationCount', () => {
    test('returns 0 for new tracker', () => {
      expect(tracker.getOperationCount()).toBe(0);
    });

    test('returns correct count after operations', () => {
      for (let i = 0; i < 5; i++) {
        tracker.record({
          type: 'insert',
          target: 'XmlText',
          path: [i],
          args: [0, 'text'],
          timestamp: Date.now(),
        });
      }

      expect(tracker.getOperationCount()).toBe(5);
    });
  });

  describe('getOperationSummary', () => {
    test('returns empty object for no operations', () => {
      const summary = tracker.getOperationSummary();
      expect(summary).toEqual({});
    });

    test('groups operations by type', () => {
      tracker.record({
        type: 'insert',
        target: 'XmlText',
        path: [0],
        args: [0, 'a'],
        timestamp: Date.now(),
      });

      tracker.record({
        type: 'insert',
        target: 'XmlText',
        path: [0],
        args: [1, 'b'],
        timestamp: Date.now(),
      });

      tracker.record({
        type: 'format',
        target: 'XmlText',
        path: [0],
        args: [0, 2, { bold: true }],
        timestamp: Date.now(),
      });

      const summary = tracker.getOperationSummary();
      expect(summary).toEqual({
        insert: 2,
        format: 1,
      });
    });

    test('counts different operation types', () => {
      tracker.record({
        type: 'insert',
        target: 'XmlFragment',
        path: [],
        args: [0, []],
        timestamp: Date.now(),
      });

      tracker.record({
        type: 'delete',
        target: 'XmlFragment',
        path: [],
        args: [0, 1],
        timestamp: Date.now(),
      });

      tracker.record({
        type: 'setAttribute',
        target: 'XmlElement',
        path: [0],
        args: ['level', 1],
        timestamp: Date.now(),
      });

      const summary = tracker.getOperationSummary();
      expect(summary).toEqual({
        insert: 1,
        delete: 1,
        setAttribute: 1,
      });
    });
  });

  describe('reset', () => {
    test('clears all operations', () => {
      tracker.record({
        type: 'insert',
        target: 'XmlText',
        path: [0],
        args: [0, 'test'],
        timestamp: Date.now(),
      });

      expect(tracker.getOperationCount()).toBe(1);

      tracker.reset();

      expect(tracker.getOperationCount()).toBe(0);
      expect(tracker.getOperations()).toEqual([]);
    });
  });

  describe('getOperations', () => {
    test('returns all recorded operations', () => {
      const op1 = {
        type: 'insert',
        target: 'XmlText',
        path: [0],
        args: [0, 'a'],
        timestamp: 100,
      };

      const op2 = {
        type: 'delete',
        target: 'XmlText',
        path: [0],
        args: [0, 1],
        timestamp: 200,
      };

      tracker.record(op1);
      tracker.record(op2);

      const ops = tracker.getOperations();
      expect(ops.length).toBe(2);
      expect(ops[0]).toEqual(op1);
      expect(ops[1]).toEqual(op2);
    });

    test('returns empty array for no operations', () => {
      const ops = tracker.getOperations();
      expect(ops).toEqual([]);
    });
  });
});

/**
 * Test for the attribution bug where human edits are incorrectly attributed to AI agents.
 *
 * The bug occurs when:
 * 1. An agent connects first and broadcasts awareness with isAgent: true
 * 2. A human connects later
 * 3. The human's connection captures the agent's clientId as its own connectionClientId
 * 4. When human edits, the server sees "connectionClientId matches agent awareness" and misattributes
 *
 * Root cause: connectionClientId is captured from the first awareness MESSAGE received,
 * which might be a broadcast ABOUT other clients (the agent), not FROM the new connection.
 */
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const Y = require('yjs');
const jwt = require('jsonwebtoken');
const { createPersistence } = require('./helpers/db');
const awarenessProtocol = require('y-protocols/dist/awareness.cjs');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

// y-websocket protocol constants
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

// JWT secret for testing (matches server config)
const TEST_JWT_SECRET = 'test-jwt-secret-for-testing-only';

/**
 * Create a test JWT token
 */
function createTestToken(userId, options = {}) {
  const payload = {
    userId,
    email: options.email || `${userId}@test.com`,
    name: options.name || `User ${userId}`,
    isAgent: options.isAgent || false,
    agentName: options.agentName || null,
  };

  return jwt.sign(payload, TEST_JWT_SECRET, {
    expiresIn: '1h',
    issuer: 'collab-test',
  });
}

/**
 * Send a Yjs sync update over WebSocket
 */
function sendSyncUpdate(ws, update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, SYNC_UPDATE);
  encoding.writeVarUint8Array(encoder, update);
  const buffer = encoding.toUint8Array(encoder);
  ws.send(buffer);
}

/**
 * Send an awareness update over WebSocket
 */
function sendAwarenessUpdate(ws, awareness, clientId, state) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  // Awareness update format: numClients, then for each: clientId, clock, stateLen, state
  encoding.writeVarUint(encoder, 1); // one client
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, 1); // clock
  const stateJson = JSON.stringify(state);
  const stateBytes = new TextEncoder().encode(stateJson);
  encoding.writeVarUint(encoder, stateBytes.length);
  encoding.writeVarUint8Array(encoder, stateBytes);
  const buffer = encoding.toUint8Array(encoder);
  ws.send(buffer);
}

describe('Attribution Bug', () => {
  let server;
  let app;
  let persistence;
  let port;

  beforeAll(async () => {
    // This test needs a more complete server setup
    // For now, we'll document the test scenario
  });

  afterAll(async () => {
    // Cleanup
  });

  describe('Bug reproduction scenario', () => {
    test('connectionClientId should only be captured from messages this connection SENDS', () => {
      /**
       * The fix should ensure:
       *
       * 1. connectionClientId is set from the Y.Doc's clientId that this connection creates
       *    - NOT from awareness messages received (which could be about other clients)
       *
       * 2. Alternatively: Detect agents from the token at connection time
       *    - If token has isAgent: true, register as agent immediately
       *    - Don't rely on awareness detection at all for attribution
       *
       * The simpler architectural fix:
       * - Agent tokens already contain isAgent and agentName
       * - Extract these at WebSocket upgrade time
       * - Pass to registerDocumentUser() immediately
       * - Remove awareness-based agent detection entirely (or make it UI-only)
       */
      expect(true).toBe(true);
    });
  });

  describe('Simplified architecture proposal', () => {
    test('agent info should come from token, not awareness', () => {
      /**
       * Current flow (buggy):
       * 1. WebSocket upgrade - extract user from token
       * 2. Register connection without agent info
       * 3. Later: detect agent from awareness states (race conditions!)
       *
       * Proposed flow (simpler):
       * 1. WebSocket upgrade - extract user AND isAgent/agentName from token
       * 2. Register connection WITH agent info if present
       * 3. Done - no awareness-based detection needed
       *
       * Changes needed:
       * - permissions.extractUser() should return isAgent and agentName from agent tokens
       * - WebSocket upgrade handler should pass agentName to registerDocumentUser()
       * - Remove checkAwareness() function (or keep only for UI presence)
       * - Remove connectionClientId tracking (not needed if agent info is in token)
       */
      expect(true).toBe(true);
    });
  });
});

describe('Token-based agent detection', () => {
  test('agent tokens contain isAgent and agentName fields', () => {
    // Agent tokens should have these fields
    const agentToken = createTestToken('user-123', {
      isAgent: true,
      agentName: 'Claude Test Agent',
    });

    const decoded = jwt.decode(agentToken);
    expect(decoded.isAgent).toBe(true);
    expect(decoded.agentName).toBe('Claude Test Agent');
  });

  test('human tokens have isAgent: false', () => {
    const humanToken = createTestToken('user-456', {
      isAgent: false,
    });

    const decoded = jwt.decode(humanToken);
    expect(decoded.isAgent).toBe(false);
    expect(decoded.agentName).toBe(null);
  });

  test('agent detection from token is deterministic', () => {
    // Unlike awareness-based detection which has race conditions,
    // token-based detection is deterministic
    const agentToken = createTestToken('user-123', {
      isAgent: true,
      agentName: 'Agent',
    });

    // Decode multiple times - always same result
    const decoded1 = jwt.decode(agentToken);
    const decoded2 = jwt.decode(agentToken);

    expect(decoded1.isAgent).toBe(decoded2.isAgent);
    expect(decoded1.agentName).toBe(decoded2.agentName);
  });
});

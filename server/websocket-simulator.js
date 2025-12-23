/**
 * WebSocket Connection Simulator
 *
 * Simulates flaky/high-latency connections for testing purposes.
 * Introduces random delays, connection drops, and packet loss.
 *
 * Enable with environment variables:
 * - WS_SIMULATE_FLAKY=true - Enable simulation
 * - WS_MIN_DELAY=100 - Min message delay in ms (default: 100)
 * - WS_MAX_DELAY=2000 - Max message delay in ms (default: 2000)
 * - WS_DROP_RATE=0.1 - Connection drop probability 0-1 (default: 0.1 = 10%)
 * - WS_PACKET_LOSS=0.05 - Message drop probability 0-1 (default: 0.05 = 5%)
 * - WS_DROP_INTERVAL_MIN=5000 - Min time between drops in ms (default: 5000)
 * - WS_DROP_INTERVAL_MAX=15000 - Max time between drops in ms (default: 15000)
 */

const ENABLED = process.env.WS_SIMULATE_FLAKY === 'true';
const MIN_DELAY = parseInt(process.env.WS_MIN_DELAY || '100', 10);
const MAX_DELAY = parseInt(process.env.WS_MAX_DELAY || '2000', 10);
const DROP_RATE = parseFloat(process.env.WS_DROP_RATE || '0.1');
const PACKET_LOSS = parseFloat(process.env.WS_PACKET_LOSS || '0.05');
const DROP_INTERVAL_MIN = parseInt(process.env.WS_DROP_INTERVAL_MIN || '5000', 10);
const DROP_INTERVAL_MAX = parseInt(process.env.WS_DROP_INTERVAL_MAX || '15000', 10);

/**
 * Get random delay in the configured range
 */
function getRandomDelay() {
  return MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
}

/**
 * Get random interval for next connection drop
 */
function getRandomDropInterval() {
  return DROP_INTERVAL_MIN + Math.random() * (DROP_INTERVAL_MAX - DROP_INTERVAL_MIN);
}

/**
 * Check if a message should be dropped (packet loss)
 */
function shouldDropMessage() {
  return Math.random() < PACKET_LOSS;
}

/**
 * Wrap a WebSocket to simulate flaky connection behavior
 *
 * @param {WebSocket} ws - The WebSocket instance to wrap
 * @returns {WebSocket} The wrapped WebSocket (or original if simulation disabled)
 */
function simulateFlakyConnection(ws) {
  if (!ENABLED) {
    console.log('[WS Simulator] Disabled - using normal connection');
    return ws;
  }

  console.log('[WS Simulator] ⚠️  ENABLED - Simulating flaky connection:', {
    minDelay: MIN_DELAY,
    maxDelay: MAX_DELAY,
    dropRate: DROP_RATE,
    packetLoss: PACKET_LOSS,
    dropIntervalMin: DROP_INTERVAL_MIN,
    dropIntervalMax: DROP_INTERVAL_MAX
  });

  // Store the original send method
  const originalSend = ws.send.bind(ws);
  const originalClose = ws.close.bind(ws);

  // Track delayed messages so we can cancel them if connection closes
  const pendingTimeouts = new Set();

  // Intercept send to add delay and packet loss
  ws.send = function(data, options, callback) {
    // Simulate packet loss - randomly drop messages
    if (shouldDropMessage()) {
      console.log('[WS Simulator] 📦 Packet dropped (simulated packet loss)');
      return; // Drop the message
    }

    // Add random delay to message
    const delay = getRandomDelay();
    const timeoutId = setTimeout(() => {
      pendingTimeouts.delete(timeoutId);
      if (ws.readyState === ws.OPEN) {
        originalSend(data, options, callback);
      }
    }, delay);
    pendingTimeouts.add(timeoutId);
  };

  // Schedule random connection drops
  let dropTimeoutId = null;

  const scheduleNextDrop = () => {
    if (ws.readyState !== ws.OPEN) return;

    const interval = getRandomDropInterval();
    console.log(`[WS Simulator] ⏱️  Next connection drop scheduled in ${(interval / 1000).toFixed(1)}s`);

    dropTimeoutId = setTimeout(() => {
      if (ws.readyState === ws.OPEN && Math.random() < DROP_RATE) {
        console.log('[WS Simulator] 🔌 Simulating connection drop!');
        // Close with code 1001 (Going Away) to simulate network interruption
        // Note: 1006 is reserved and can't be sent, only received
        originalClose.call(ws, 1001, 'Simulated connection drop');
      } else {
        console.log('[WS Simulator] ✅ Drop skipped this time');
        // Schedule next potential drop
        scheduleNextDrop();
      }
    }, interval);
  };

  // Start scheduling drops
  scheduleNextDrop();

  // Clean up on close
  const originalOnClose = ws.onclose;
  ws.onclose = function(event) {
    console.log('[WS Simulator] Connection closed, cleaning up');
    // Clear pending drops
    if (dropTimeoutId) {
      clearTimeout(dropTimeoutId);
      dropTimeoutId = null;
    }
    // Clear pending message sends
    pendingTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    pendingTimeouts.clear();

    if (originalOnClose) {
      originalOnClose.call(this, event);
    }
  };

  return ws;
}

/**
 * Log simulator status on startup
 */
function logStatus() {
  if (ENABLED) {
    console.log('\n' + '='.repeat(70));
    console.log('🔧 WEBSOCKET SIMULATOR ENABLED');
    console.log('='.repeat(70));
    console.log('Configuration:');
    console.log(`  - Message delay: ${MIN_DELAY}ms - ${MAX_DELAY}ms`);
    console.log(`  - Packet loss rate: ${(PACKET_LOSS * 100).toFixed(1)}%`);
    console.log(`  - Connection drop rate: ${(DROP_RATE * 100).toFixed(1)}%`);
    console.log(`  - Drop interval: ${(DROP_INTERVAL_MIN / 1000).toFixed(1)}s - ${(DROP_INTERVAL_MAX / 1000).toFixed(1)}s`);
    console.log('='.repeat(70) + '\n');
  } else {
    console.log('[WS Simulator] Not enabled (set WS_SIMULATE_FLAKY=true to enable)');
  }
}

module.exports = {
  simulateFlakyConnection,
  logStatus,
  isEnabled: () => ENABLED
};

# WebSocket Connection Simulator

A testing tool to simulate flaky/high-latency network conditions for the WebSocket connections. This helps reproduce and debug connection-related bugs.

## Quick Start

### Enable the Simulator

Add these environment variables to your `.env` file:

```bash
# Enable the simulator
WS_SIMULATE_FLAKY=true

# Message delay range (milliseconds)
WS_MIN_DELAY=100
WS_MAX_DELAY=2000

# Connection drop rate (0.0 to 1.0)
# 0.1 = 10% chance of drop per interval
WS_DROP_RATE=0.1

# Packet loss rate (0.0 to 1.0)
# 0.05 = 5% of messages randomly dropped
WS_PACKET_LOSS=0.05

# Time between potential connection drops (milliseconds)
WS_DROP_INTERVAL_MIN=5000
WS_DROP_INTERVAL_MAX=15000
```

### Start the Server

```bash
npm run dev
```

You should see output like:

```
======================================================================
🔧 WEBSOCKET SIMULATOR ENABLED
======================================================================
Configuration:
  - Message delay: 100ms - 2000ms
  - Packet loss rate: 5.0%
  - Connection drop rate: 10.0%
  - Drop interval: 5.0s - 15.0s
======================================================================
```

## Configuration Options

### WS_SIMULATE_FLAKY
- **Type**: `boolean` (true/false)
- **Default**: `false`
- **Description**: Master switch to enable/disable the simulator

### WS_MIN_DELAY
- **Type**: `number` (milliseconds)
- **Default**: `100`
- **Description**: Minimum delay added to each message

### WS_MAX_DELAY
- **Type**: `number` (milliseconds)
- **Default**: `2000`
- **Description**: Maximum delay added to each message
- **Note**: Each message gets a random delay between MIN and MAX

### WS_DROP_RATE
- **Type**: `number` (0.0 to 1.0)
- **Default**: `0.1`
- **Description**: Probability that a scheduled drop actually happens
- **Example**: `0.1` = 10% chance, `0.5` = 50% chance

### WS_PACKET_LOSS
- **Type**: `number` (0.0 to 1.0)
- **Default**: `0.05`
- **Description**: Probability that each message is dropped
- **Example**: `0.05` = 5% of messages dropped, `0.2` = 20% dropped

### WS_DROP_INTERVAL_MIN
- **Type**: `number` (milliseconds)
- **Default**: `5000`
- **Description**: Minimum time between potential connection drops

### WS_DROP_INTERVAL_MAX
- **Type**: `number` (milliseconds)
- **Default**: `15000`
- **Description**: Maximum time between potential connection drops
- **Note**: The simulator schedules drops at random intervals in this range

## Example Scenarios

### Mild Network Issues
Simulates occasional hiccups like a shaky WiFi connection:

```bash
WS_SIMULATE_FLAKY=true
WS_MIN_DELAY=50
WS_MAX_DELAY=500
WS_DROP_RATE=0.05
WS_PACKET_LOSS=0.01
WS_DROP_INTERVAL_MIN=20000
WS_DROP_INTERVAL_MAX=40000
```

### Moderate Network Issues
Simulates poor connectivity like a weak cellular signal:

```bash
WS_SIMULATE_FLAKY=true
WS_MIN_DELAY=200
WS_MAX_DELAY=3000
WS_DROP_RATE=0.2
WS_PACKET_LOSS=0.1
WS_DROP_INTERVAL_MIN=10000
WS_DROP_INTERVAL_MAX=20000
```

### Severe Network Issues
Simulates terrible network conditions (like VPN constantly reconnecting):

```bash
WS_SIMULATE_FLAKY=true
WS_MIN_DELAY=500
WS_MAX_DELAY=5000
WS_DROP_RATE=0.5
WS_PACKET_LOSS=0.2
WS_DROP_INTERVAL_MIN=3000
WS_DROP_INTERVAL_MAX=8000
```

### High Latency Only
Simulates high latency without drops (like a slow satellite connection):

```bash
WS_SIMULATE_FLAKY=true
WS_MIN_DELAY=1000
WS_MAX_DELAY=3000
WS_DROP_RATE=0.0
WS_PACKET_LOSS=0.0
WS_DROP_INTERVAL_MIN=999999999
WS_DROP_INTERVAL_MAX=999999999
```

## What Gets Simulated

### Message Delays
- Every outgoing message from the server gets a random delay
- Delay is between `WS_MIN_DELAY` and `WS_MAX_DELAY`
- Helps test how the app handles slow message delivery

### Packet Loss
- Messages are randomly dropped before sending
- Drop rate controlled by `WS_PACKET_LOSS`
- Simulates unreliable network conditions

### Connection Drops
- Connections are randomly closed with code 1006 (abnormal closure)
- Drop timing controlled by `WS_DROP_INTERVAL_MIN/MAX`
- Drop probability controlled by `WS_DROP_RATE`
- Simulates network interruptions, WiFi handoffs, VPN reconnects, etc.

## Debugging Tips

### Check Simulator Status
Look for the banner in the server logs when it starts:

```
🔧 WEBSOCKET SIMULATOR ENABLED
```

### Monitor Simulated Events
The simulator logs all simulated events:

```
[WS Simulator] ⏱️  Next connection drop scheduled in 8.5s
[WS Simulator] 📦 Packet dropped (simulated packet loss)
[WS Simulator] 🔌 Simulating connection drop!
[WS Simulator] ✅ Drop skipped this time
```

### Test Reconnection Behavior
1. Enable the simulator with moderate settings
2. Open a document in the browser
3. Watch the connection status indicator
4. Observe how the app handles:
   - Disconnection notifications
   - Reconnection attempts
   - State sync after reconnection
   - Scroll position preservation

### Disable for Normal Development
Simply remove or comment out `WS_SIMULATE_FLAKY=true` from your `.env`:

```bash
# WS_SIMULATE_FLAKY=true
```

Or set it to false:

```bash
WS_SIMULATE_FLAKY=false
```

## Known Issues to Test

### Scroll Position Reset (CURRENT BUG)
The reported bug: "When connection drops/reconnects, it resets the view to the top of the page"

**How to reproduce:**
1. Enable simulator with moderate connection drops:
   ```bash
   WS_SIMULATE_FLAKY=true
   WS_DROP_RATE=0.5
   WS_DROP_INTERVAL_MIN=5000
   WS_DROP_INTERVAL_MAX=10000
   ```
2. Open a document with lots of content
3. Scroll down below the fold
4. Wait for a simulated connection drop
5. Observe if scroll position is maintained after reconnection

## Implementation Details

### How It Works
The simulator wraps the WebSocket instance and:
1. Intercepts the `send()` method to add delays and packet loss
2. Schedules random connection drops using `setTimeout`
3. Cleans up timers when the connection closes

### Where It's Applied
The wrapper is applied in `server/index.js` after the WebSocket upgrade:

```javascript
wss.handleUpgrade(request, socket, head, (ws) => {
  const wrappedWs = wsSimulator.simulateFlakyConnection(ws);
  wss.emit('connection', wrappedWs, request);
});
```

### Performance Impact
- When disabled: Zero overhead (returns original WebSocket unmodified)
- When enabled: Minimal overhead (just setTimeout calls)
- Safe for development use

## See Also

- [Development Environment Guide](./dev.md) - General development setup
- [README](../README.md) - Project overview and features

# Development Environment Guide

This guide explains how to work with the Kubernetes-based development environment using Minikube and Mutagen for file synchronization.

## Architecture Overview

The development setup consists of:
- **Minikube**: Local Kubernetes cluster
- **app-dev Pod**: Kubernetes pod running the development container
- **Mutagen**: Two-way file sync between your local machine and the pod
- **Port-forwarding**: Access services running in the pod from your local machine

## Prerequisites

- [Minikube](https://minikube.sigs.k8s.io/docs/start/) installed and running
- [kubectl](https://kubernetes.io/docs/tasks/tools/) configured
- [Mutagen](https://mutagen.io/documentation/introduction/installation) installed
- Docker (used by Minikube)

## Setup

### 1. Deploy the Development Pod

```bash
# Apply the development deployment
kubectl apply -f k8s/app-dev.yaml

# Verify the pod is running
kubectl get pods -n collab -l app=app-dev
```

### 2. Set Up Mutagen File Sync

Mutagen syncs your local code to the pod in real-time, enabling live reload during development.

```bash
# Run the mutagen setup script
./script/mutagen.sh
```

**What the script does:**
1. Switches to Minikube's Docker daemon
2. Finds the app-dev container ID
3. Creates a two-way sync between your local directory and `/local-dev` in the container
4. Installs npm dependencies in the container
5. Configures sync to ignore `node_modules/`, `.git/`, `client/dist/`, etc.

**Sync Mode:** `two-way-safe` - Changes in either direction are synced, with conflict detection

### 3. Start the Development Servers

```bash
# Connect to the pod
kubectl exec -it deployment/app-dev -n collab -- sh

# Once inside the pod, start the dev servers
cd /local-dev
npm run dev
```

This starts:
- Express backend on port 3001
- Vite frontend dev server on port 5173

## Connecting to the Dev Pod

### Interactive Shell Access

Get a shell inside the running pod:

```bash
# Using deployment name (recommended)
kubectl exec -it deployment/app-dev -n collab -- sh

# Or using pod name directly
kubectl exec -it <pod-name> -n collab -- sh
```

### Running One-off Commands

Execute commands without entering the pod:

```bash
# Check Node version
kubectl exec deployment/app-dev -n collab -- node --version

# Install dependencies
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm install"

# Run tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm test"

# Check running processes
kubectl exec deployment/app-dev -n collab -- ps aux | grep node
```

### Viewing Logs

```bash
# Stream logs from the pod
kubectl logs -f deployment/app-dev -n collab

# Get last 50 lines
kubectl logs --tail=50 deployment/app-dev -n collab
```

## Port Forwarding

To access services running in the pod from your local browser:

### Forward Vite Dev Server (Frontend)

```bash
# Forward local port 4567 to pod's port 5173 (Vite)
kubectl port-forward deployment/app-dev 4567:5173 -n collab
```

Then open http://localhost:4567 in your browser.

### Forward Express Server (Backend)

```bash
# Forward local port 3001 to pod's port 3001 (Express)
kubectl port-forward deployment/app-dev 3001:3001 -n collab
```

### Forward Multiple Ports

```bash
# Forward both frontend and backend
kubectl port-forward deployment/app-dev 4567:5173 3001:3001 -n collab
```

**Note:** The Vite config is set up to work with port-forward. HMR (Hot Module Reload) is configured to use the forwarded port.

## How Mutagen Sync Works

### Sync Architecture

```
┌─────────────────┐         Mutagen         ┌──────────────────────┐
│  Local Machine  │ ◄─────────────────────► │  Minikube Container  │
│  (Your Files)   │    Two-way sync         │   /local-dev/        │
└─────────────────┘                          └──────────────────────┘
```

### Sync Configuration

From `script/mutagen.sh`:

```bash
mutagen sync create . "docker://$CONTAINER_ID/local-dev" \
  --ignore=node_modules/,client/node_modules/,.git/,client/dist/,data/,log/ \
  --ignore-vcs \
  --sync-mode=two-way-safe \
  --name=app-sync
```

**Ignored Paths:**
- `node_modules/` - Dependencies (installed separately in container)
- `.git/` - Version control
- `client/dist/` - Build artifacts
- `data/`, `log/` - Runtime data

**Sync Mode:** `two-way-safe`
- Changes on your local machine → sync to container
- Changes in container → sync to local machine
- Conflicts are detected and require manual resolution

### Managing Sync

```bash
# List active syncs
mutagen sync list

# Check sync status
mutagen sync monitor app-sync

# Pause sync
mutagen sync pause app-sync

# Resume sync
mutagen sync resume app-sync

# Terminate sync
mutagen sync terminate app-sync

# Restart sync (useful if things get stuck)
mutagen sync terminate app-sync
./scripts/mutagen.sh
```

### Sync Troubleshooting

**Sync not working?**

```bash
# 1. Check sync status
mutagen sync list

# 2. Look for errors
mutagen sync monitor app-sync

# 3. Restart the sync
mutagen sync terminate app-sync
./script/mutagen.sh

# 4. Verify container is running
kubectl get pods -n collab -l app=app-dev
```

**Files not appearing in the pod?**

Check if the path is being ignored by the sync configuration. Mutagen ignores `node_modules/`, `.git/`, and build artifacts by default.

**Conflicts detected?**

```bash
# View conflicts
mutagen sync monitor app-sync

# Reset and re-sync
mutagen sync terminate app-sync
./script/mutagen.sh
```

## Common Development Workflows

### Workflow 1: Local Development with Live Reload

```bash
# Terminal 1: Set up sync
./script/mutagen.sh

# Terminal 2: Connect to pod and start dev servers
kubectl exec -it deployment/app-dev -n collab -- sh
cd /local-dev
npm run dev

# Terminal 3: Port-forward to access from browser
kubectl port-forward deployment/app-dev 4567:5173 -n collab

# Now edit files locally - changes sync and trigger reload automatically
```

### Workflow 2: Running Tests

```bash
# Backend tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm test"

# Frontend tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev/client && npm test"

# Integration tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run test:collab"
```

### Workflow 3: Installing New Dependencies

```bash
# Option A: Install locally and let Mutagen sync
npm install <package>
# Wait for sync, then restart dev server in pod

# Option B: Install directly in pod
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm install <package>"

# For frontend dependencies
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev/client && npm install <package>"
```

### Workflow 4: Database Operations

```bash
# Run migrations
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run migrate"

# Connect to PostgreSQL
kubectl exec -it deployment/collab-postgres -n collab -- psql -U postgres -d collab_db

# Initialize database
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run init-db"
```

## Development Authentication Bypass

For easier development and mobile testing, the application supports bypassing Google OAuth authentication and automatically logging in with a test user.

### How to Enable

Set the `VITE_BYPASS_AUTH` environment variable to `true` in `client/.env`:

```bash
VITE_BYPASS_AUTH=true
```

### How It Works

When auth bypass is enabled:

1. **Auto-login**: The app automatically logs you in as a test user (`dev@test.local`) when you load the page
2. **No OAuth redirect**: Clicking "Login" calls the `/auth/dev-login` endpoint instead of redirecting to Google OAuth
3. **Development-only**: The `/auth/dev-login` endpoint only works when `NODE_ENV=development`

### Test User Details

- **Email**: `dev@test.local`
- **Name**: `Dev Test User`
- **Google ID**: `dev-test-user`

### Use Cases

- **Mobile testing**: Test on physical devices over HTTP (where `crypto.randomUUID()` may not be available)
- **Quick iteration**: Skip OAuth flow during rapid development
- **Offline development**: Work without internet connection

### Security

The dev-login endpoint includes several safety measures:

- Only available when `NODE_ENV=development`
- Returns 403 Forbidden in production
- Test user is clearly identifiable by email domain

### Disabling

To disable auth bypass and use real Google OAuth:

```bash
# In client/.env
VITE_BYPASS_AUTH=false
```

Or simply remove the environment variable.

## Mobile Testing on Local Network

To test the application on a mobile device connected to the same local network:

### 1. Set Up Port-Forward for Network Access

Use the `--address 0.0.0.0` flag to bind port-forward to all network interfaces:

```bash
kubectl port-forward deployment/app-dev --address 0.0.0.0 60175:5173 -n collab
```

This makes the app accessible from any device on your local network.

### 2. Find Your Local IP Address

```bash
# On macOS/Linux
ifconfig | grep "inet " | grep -v 127.0.0.1
```

### 3. Access from Mobile

Open your mobile browser and navigate to:

```
http://YOUR_LOCAL_IP:60175
```

For example: `http://192.168.50.121:60175`

### 4. Enable Auth Bypass

Since mobile devices accessing via HTTP (not HTTPS) may have limited Web Crypto API support, enable auth bypass in `client/.env`:

```bash
VITE_BYPASS_AUTH=true
```

This bypasses OAuth and automatically logs you in for testing.

### Troubleshooting Mobile Testing

**Firewall Issues**
- Ensure your Mac's firewall allows incoming connections on the forwarded port
- Check System Settings > Network > Firewall

**Same Network Required**
- Mobile device and development machine must be on the same Wi-Fi network

**UUID Generation**
- The app includes a fallback UUID generator for non-secure contexts (HTTP)
- `crypto.randomUUID()` requires HTTPS, so we fall back to `Math.random()` over HTTP

**Hot Module Reload (HMR)**
- HMR may not work perfectly from mobile since Vite's HMR is configured for localhost
- Manually refresh the page after making changes

## Vite Configuration for Port-Forward

The `client/vite.config.js` is configured to work with kubectl port-forward:

```javascript
server: {
  host: '0.0.0.0',              // Bind to all interfaces
  port: 5173,                    // Internal port
  strictPort: false,             // Allow fallback if port busy
  fs: {
    strict: false                // Allow access to synced files
  },
  hmr: {
    protocol: 'ws',
    host: 'localhost',
    port: 4567                   // Match port-forward external port
  },
  proxy: {
    '^/s($|/)': {                // WebSocket proxy (regex to avoid matching /src)
      target: 'ws://localhost:3001',
      ws: true,
      changeOrigin: true
    }
  }
}
```

**Key Points:**
- `host: '0.0.0.0'` - Allows external connections (required for port-forward)
- `hmr.port: 4567` - HMR uses the port-forward external port
- `'^/s($|/)'` - Regex pattern to proxy only `/s` or `/s/*` (not `/src`)

## Troubleshooting

### Pod Not Starting

```bash
# Check pod status
kubectl get pods -n collab -l app=app-dev

# View pod events
kubectl describe pod -l app=app-dev -n collab

# Check logs
kubectl logs deployment/app-dev -n collab
```

### Port Conflicts

If you get "address already in use" errors:

```bash
# Connect to pod
kubectl exec -it deployment/app-dev -n collab -- sh

# Find processes using ports
netstat -tlnp | grep -E '(3001|5173)'

# Kill stuck processes
pkill -f node

# Restart dev servers
npm run dev
```

### Mutagen Container ID Changed

After redeploying or pod restart, the container ID changes:

```bash
# Terminate old sync
mutagen sync terminate app-sync

# Re-run setup script
./script/mutagen.sh
```

### Vite MIME Type Errors

If you see "disallowed MIME type" errors:

1. Check the proxy configuration in `client/vite.config.js`
2. Ensure the regex pattern is `'^/s($|/)'` (not just `'/s'`)
3. Restart the Vite server in the pod:
   ```bash
   kubectl exec deployment/app-dev -n collab -- pkill -f vite
   # Then restart npm run dev
   ```

### WebSocket Connection Issues

If the editor shows "Disconnected":

1. Verify port-forward is running for both ports (3001 and 5173)
2. Check that Express server is running on port 3001
3. Verify the proxy configuration in Vite config
4. Check browser console for WebSocket errors

### Files Not Syncing

```bash
# Check sync status
mutagen sync list
mutagen sync monitor app-sync

# Verify container is accessible
docker ps | grep app-dev

# Restart sync
mutagen sync terminate app-sync
./script/mutagen.sh
```

## Best Practices

1. **Always use the deployment name** in kubectl commands (not pod name) - pod names change on restart
2. **Keep Mutagen sync running** while developing - it's the bridge between your local files and the pod
3. **Install dependencies in the pod** after sync is set up - don't sync node_modules
4. **Use port-forward** for accessing services - don't expose LoadBalancer in dev
5. **Monitor sync status** if files aren't updating - `mutagen sync monitor app-sync`
6. **Restart dev servers** after config changes - Vite and Express don't always hot-reload config

## Useful Commands Reference

```bash
# === Pod Management ===
kubectl get pods -n collab                                    # List all pods
kubectl exec -it deployment/app-dev -n collab -- sh          # Enter pod shell
kubectl logs -f deployment/app-dev -n collab                 # Stream logs
kubectl describe pod -l app=app-dev -n collab                # Pod details

# === Mutagen ===
mutagen sync list                                             # List syncs
mutagen sync monitor app-sync                                 # Watch sync status
mutagen sync terminate app-sync                               # Stop sync
./script/mutagen.sh                                           # Setup sync

# === Port Forwarding ===
kubectl port-forward deployment/app-dev 4567:5173 -n collab  # Forward Vite
kubectl port-forward deployment/app-dev 3001:3001 -n collab  # Forward Express

# === Development ===
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run dev"      # Start servers
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm test"         # Run tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run migrate"  # Migrate DB
kubectl exec deployment/app-dev -n collab -- pkill -f node                             # Kill processes
```

## Next Steps

- See [README.md](../README.md) for application features and usage
- See [plan.md](./plan.md) for project roadmap and architecture
- See [phase1.md](./phase1.md) for current phase implementation details





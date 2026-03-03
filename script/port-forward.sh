#!/bin/bash

# Port Forward Script for Development Environment
# Sets up port-forwards for local network access (including mobile devices)
# Usage: ./script/port-forward.sh [frontend-port] [backend-port]

set -e

DEPLOYMENT_NAME="app-dev"
NAMESPACE="collab"

# Default ports
FRONTEND_PORT="${1:-50308}"
BACKEND_PORT="${2:-3001}"

# Pod ports (these are fixed - Vite and Express ports in the pod)
POD_FRONTEND_PORT="5173"
POD_BACKEND_PORT="3001"

echo "=== Port Forward Setup for Local Network Access ==="
echo ""

# Check if deployment exists
if ! kubectl get deployment $DEPLOYMENT_NAME -n $NAMESPACE >/dev/null 2>&1; then
    echo "❌ $DEPLOYMENT_NAME deployment not found in namespace $NAMESPACE"
    echo "   Please deploy the development pod first:"
    echo "   kubectl apply -f k8s/app-dev.yaml"
    exit 1
fi

# Wait for the pod to be ready
echo "Waiting for $DEPLOYMENT_NAME pod to be ready..."
kubectl wait --for=condition=ready pod -l app=$DEPLOYMENT_NAME -n $NAMESPACE --timeout=60s || {
    echo "❌ Pod is not ready. Check pod status:"
    echo "   kubectl get pods -n $NAMESPACE -l app=$DEPLOYMENT_NAME"
    exit 1
}

# Check if port-forwards are already running
EXISTING_PF=$(ps aux | grep "kubectl port-forward.*$DEPLOYMENT_NAME" | grep -v grep || true)
if [ -n "$EXISTING_PF" ]; then
    echo "⚠️  Existing port-forward processes detected:"
    echo "$EXISTING_PF"
    echo ""
    read -p "Kill existing port-forwards and start new ones? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Killing existing port-forward processes..."
        pkill -f "kubectl port-forward.*$DEPLOYMENT_NAME" || true
        sleep 1
    else
        echo "Aborted. Please stop existing port-forwards manually."
        exit 1
    fi
fi

# Get local IP address
LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -n 1)

if [ -z "$LOCAL_IP" ]; then
    echo "⚠️  Could not detect local IP address"
    LOCAL_IP="YOUR_LOCAL_IP"
fi

echo "Setting up port-forwards with --address 0.0.0.0 (accessible from local network)..."
echo ""

# Start frontend port-forward in background
echo "Starting frontend port-forward: $FRONTEND_PORT -> $POD_FRONTEND_PORT"
kubectl port-forward deployment/$DEPLOYMENT_NAME --address 0.0.0.0 $FRONTEND_PORT:$POD_FRONTEND_PORT -n $NAMESPACE > /dev/null 2>&1 &
FRONTEND_PID=$!

# Start backend port-forward in background
echo "Starting backend port-forward: $BACKEND_PORT -> $POD_BACKEND_PORT"
kubectl port-forward deployment/$DEPLOYMENT_NAME --address 0.0.0.0 $BACKEND_PORT:$POD_BACKEND_PORT -n $NAMESPACE > /dev/null 2>&1 &
BACKEND_PID=$!

# Wait a moment for port-forwards to establish
sleep 2

# Verify port-forwards are running
if ! ps -p $FRONTEND_PID > /dev/null 2>&1; then
    echo "❌ Frontend port-forward failed to start"
    exit 1
fi

if ! ps -p $BACKEND_PID > /dev/null 2>&1; then
    echo "❌ Backend port-forward failed to start"
    kill $FRONTEND_PID 2>/dev/null || true
    exit 1
fi

echo "✅ Port-forwards are running!"
echo ""
echo "=== Access Information ==="
echo ""
echo "Local access (from this machine):"
echo "  Frontend: http://localhost:$FRONTEND_PORT"
echo "  Backend:  http://localhost:$BACKEND_PORT"
echo ""
echo "Network access (from other devices on same Wi-Fi):"
echo "  Frontend: http://$LOCAL_IP:$FRONTEND_PORT"
echo "  Backend:  http://$LOCAL_IP:$BACKEND_PORT"
echo ""
echo "Process IDs:"
echo "  Frontend PID: $FRONTEND_PID"
echo "  Backend PID:  $BACKEND_PID"
echo ""
echo "To stop port-forwards:"
echo "  kill $FRONTEND_PID $BACKEND_PID"
echo "  # or"
echo "  pkill -f 'kubectl port-forward.*$DEPLOYMENT_NAME'"
echo ""
echo "To view port-forward logs:"
echo "  kubectl port-forward deployment/$DEPLOYMENT_NAME --address 0.0.0.0 $FRONTEND_PORT:$POD_FRONTEND_PORT -n $NAMESPACE"
echo "  kubectl port-forward deployment/$DEPLOYMENT_NAME --address 0.0.0.0 $BACKEND_PORT:$POD_BACKEND_PORT -n $NAMESPACE"

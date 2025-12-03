#!/bin/bash

# Mutagen Sync Script for Development Environment
# Usage: ./scripts/mutagen.sh

set -e

ENV="app"
CONTAINER_PATTERN="app-dev"
SYNC_NAME="app-sync"
DEPLOYMENT_NAME="app-dev"

echo "=== Mutagen Sync Setup for $ENV ==="

# Make sure we're using minikube's Docker daemon
eval $(minikube docker-env)

# Check if deployment exists
if ! kubectl get deployment $DEPLOYMENT_NAME -n collab >/dev/null 2>&1; then
    echo "❌ $ENV development deployment not found. Please run:"
    echo "   kubectl apply -f k8s/$ENV-dev.yaml"
    exit 1
fi

# Wait for the pod to be ready
echo "Waiting for $ENV development pod to be ready..."
kubectl wait --for=condition=ready pod -l app=$DEPLOYMENT_NAME -n collab --timeout=60s

# Get the actual container ID (not the pod name)
CONTAINER_ID=$(docker ps | grep $CONTAINER_PATTERN | grep -v pause | awk '{print $1}')

if [ -z "$CONTAINER_ID" ]; then
    echo "❌ No $ENV container found"
    echo "Available containers:"
    docker ps
    exit 1
fi

echo "Found $ENV container: $CONTAINER_ID"

# Check if mutagen sync already exists
if mutagen sync list | grep -q "$SYNC_NAME"; then
    echo "⚠️  $SYNC_NAME already exists. Terminating existing sync..."
    mutagen sync terminate $SYNC_NAME
fi

echo "Creating mutagen sync to docker://$CONTAINER_ID/local-dev"
mutagen sync create . "docker://$CONTAINER_ID/local-dev" \
  --ignore=node_modules/,client/node_modules/,.git/,client/dist/,data/,log/ \
  --ignore-vcs \
  --sync-mode=two-way-safe \
  --name=$SYNC_NAME

echo "Waiting for initial sync to complete..."
sleep 3

echo "Installing dependencies in container..."
kubectl exec deployment/$DEPLOYMENT_NAME -n collab -- sh -c "cd /local-dev && npm install"
kubectl exec deployment/$DEPLOYMENT_NAME -n collab -- sh -c "cd /local-dev/client && npm install"

echo "✅ $ENV development sync setup complete!"
echo ""
echo "To access the $ENV development container:"
echo "  kubectl exec -it deployment/$DEPLOYMENT_NAME -n collab -- sh"
echo ""
echo "To view sync status:"
echo "  mutagen sync list"
echo ""
echo "To run the dev server:"
echo "  kubectl exec -it deployment/$DEPLOYMENT_NAME -n collab -- sh -c 'cd /local-dev && npm run dev'"


#!/bin/bash
set -x

# Safety check: Ensure we're deploying to the correct cluster
CURRENT_CONTEXT=$(kubectl config current-context)
ALLOWED_CONTEXTS=("minikube" "gke_eqtgke_us-west1-a_juicy-snowflake")
# ALLOWED_CONTEXTS=("minikube" "gke_eqtgke_us-west1-a_hardy-sun")

# Check if current context is in the allowed list
context_allowed=false
for allowed_context in "${ALLOWED_CONTEXTS[@]}"; do
  if [[ "$CURRENT_CONTEXT" == "$allowed_context" ]]; then
    context_allowed=true
    break
  fi
done

if [[ "$context_allowed" == false ]]; then
  echo "ERROR: Current kubectl context '$CURRENT_CONTEXT' is not in the allowed deployment contexts."
  echo "Allowed contexts:"
  for context in "${ALLOWED_CONTEXTS[@]}"; do
    echo "  - $context"
  done
  echo ""
  echo "Available contexts:"
  kubectl config get-contexts
  echo ""
  echo "To switch to an allowed context, run:"
  echo "  kubectl config use-context <context-name>"
  echo ""
  echo "Deployment aborted for safety."
  exit 1
fi

echo "Safety check passed. Deploying to context: $CURRENT_CONTEXT"

export TAG="$(git rev-parse HEAD)"

# Create namespace if it doesn't exist
kubectl apply -f k8s/namespace.yaml

# Deploy PostgreSQL secret
kubectl apply -f k8s/postgres-secret.yaml -n collab

# Deploy PostgreSQL persistent volume claim
kubectl apply -f k8s/postgres-data-persistentvolumeclaim.yaml -n collab

# Deploy PostgreSQL deployment
kubectl apply -f k8s/postgres-deployment.yaml -n collab

# Deploy PostgreSQL service
kubectl apply -f k8s/postgres-service.yaml -n collab

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
kubectl wait --for=condition=ready pod -l app=collab-postgres --timeout=300s -n collab

if [ $? -eq 0 ]; then
  echo "PostgreSQL is ready!"
else
  echo "ERROR: PostgreSQL failed to become ready within 5 minutes."
  exit 1
fi


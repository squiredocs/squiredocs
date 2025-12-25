#!/bin/bash
set -x

# Function to substitute environment variables in files
# Falls back to sed if envsubst is not available
envsubst_safe() {
  if command -v envsubst &> /dev/null; then
    envsubst
  else
    # Simple bash-based replacement for ${VAR} patterns
    while IFS= read -r line; do
      # Replace ${VAR} with value of VAR
      while [[ $line =~ \$\{([^}]+)\} ]]; do
        var_name="${BASH_REMATCH[1]}"
        var_value="${!var_name}"
        line="${line//\$\{$var_name\}/$var_value}"
      done
      echo "$line"
    done
  fi
}

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

# Parse command line arguments
WAIT_FOR_IMAGE=false
SKIP_MIGRATIONS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --wait)
      WAIT_FOR_IMAGE=true
      shift
      ;;
    --skip-migrations)
      SKIP_MIGRATIONS=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo "Options:"
      echo "  --wait           Wait for Docker image to become available instead of exiting"
      echo "  --skip-migrations Skip database migrations"
      echo "  --help, -h       Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

export TAG="$(git rev-parse HEAD)"

# Determine which image to use
if [[ "$CURRENT_CONTEXT" == *"minikube"* ]]; then
  export IMG=collab:latest
  echo "Minikube context detected. Using image: $IMG"
else
  export IMG="us-west1-docker.pkg.dev/eqtgke/eqt/collab:$TAG"
  echo "Non-minikube context detected. Using image: $IMG"
  
  # Check if image exists
  if [[ ! `docker manifest inspect "$IMG"` ]]; then
    if [[ "$WAIT_FOR_IMAGE" == true ]]; then
      echo "Image $IMG does not exist. Waiting for it to become available..."
      while [[ ! `docker manifest inspect "$IMG"` ]]; do
        echo "Waiting for image $IMG to become available..."
        sleep 5
      done
      echo "Image $IMG is now available!"
    else
      echo "$IMG does not exist"
      exit 1
    fi
  fi
fi

# Function to run database migrations
run_migrations() {
  if [[ "$SKIP_MIGRATIONS" == true ]]; then
    echo "Skipping database migrations (--skip-migrations flag provided)"
    return 0
  fi

  echo "Running database migrations..."
  
  # Check if PostgreSQL is ready
  echo "Checking if PostgreSQL is ready..."
  kubectl wait --for=condition=ready pod -l app=collab-postgres --timeout=60s -n collab
  
  if [ $? -ne 0 ]; then
    echo "WARNING: PostgreSQL is not ready. Skipping migrations."
    echo "Please ensure PostgreSQL is deployed and ready before running migrations."
    return 1
  fi

  # Delete any existing migration job to ensure clean state
  kubectl delete job db-migrate-job --ignore-not-found=true -n collab
  
  # Create and run the migration job
  envsubst_safe < k8s/db-migrate-job.yaml | kubectl apply -f - -n collab
  
  # Wait for the migration job to complete
  echo "Waiting for migration job to complete..."
  kubectl wait --for=condition=complete job/db-migrate-job --timeout=300s -n collab
  
  # Check if migration was successful
  if [ $? -eq 0 ]; then
    echo "Database migrations completed successfully!"
    # Show migration logs for verification
    echo "Migration logs:"
    kubectl logs job/db-migrate-job -n collab
  else
    echo "Database migration failed!"
    echo "Migration logs:"
    kubectl logs job/db-migrate-job -n collab
    exit 1
  fi
}

# Function to deploy app
deploy_app() {
  echo "Deploying app..."
  envsubst_safe < k8s/app-deployment.yaml | kubectl apply -f - -n collab
  envsubst_safe < k8s/app-service.yaml | kubectl apply -f - -n collab
  envsubst_safe < k8s/app-hpa.yaml | kubectl apply -f - -n collab
  kubectl apply -f k8s/collab-loadbalancer.yaml -n collab
}

# Create namespace if it doesn't exist
kubectl apply -f k8s/namespace.yaml

# Deploy PostgreSQL secret if it doesn't exist
kubectl apply -f k8s/postgres-secret.yaml -n collab

# Deploy Redis
echo "Deploying Redis..."
kubectl apply -f k8s/redis-data-persistentvolumeclaim.yaml -n collab
kubectl apply -f k8s/redis-deployment.yaml -n collab
kubectl apply -f k8s/redis-service.yaml -n collab

# Deploy MCP auth secret if it exists
if [[ -f "k8s/mcp-auth-secret.yaml" ]]; then
  echo "Applying MCP auth secret..."
  kubectl apply -f k8s/mcp-auth-secret.yaml -n collab
else
  echo "WARNING: k8s/mcp-auth-secret.yaml not found."
  echo "MCP OAuth authentication will not work without this secret."
  echo "Generate it with: ./script/generate-mcp-secrets.sh --k8s"
fi

# Deploy auth secret from appropriate .env file
if [[ "$CURRENT_CONTEXT" == *"minikube"* ]]; then
  AUTH_ENV_FILE="k8s/auth.env"
else
  AUTH_ENV_FILE="k8s/auth.production.env"
fi

if [[ -f "$AUTH_ENV_FILE" ]]; then
  echo "Creating/updating auth-secret from $AUTH_ENV_FILE..."
  kubectl delete secret auth-secret --ignore-not-found=true -n collab
  kubectl create secret generic auth-secret --from-env-file="$AUTH_ENV_FILE" -n collab
else
  echo "WARNING: $AUTH_ENV_FILE not found. Skipping auth-secret creation."
  echo "Authentication will not work without this secret."
fi

# Main deployment logic
echo "Deploying application..."
run_migrations
deploy_app

echo "Deployment completed!"

# Tag the deployment
echo "Tagging deployment..."
DEPLOY_TAG="deployed-$(date +%Y%m%d-%H%M%S)"
git tag -a "$DEPLOY_TAG" -m "Deployed to $CURRENT_CONTEXT at $(date)"
echo "Created tag: $DEPLOY_TAG"

# Push the tag to remote
if git push origin "$DEPLOY_TAG"; then
  echo "Successfully pushed tag $DEPLOY_TAG to remote"
else
  echo "Warning: Failed to push tag to remote (tag still exists locally)"
fi


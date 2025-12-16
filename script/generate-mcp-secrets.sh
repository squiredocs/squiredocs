#!/bin/bash
# Generate MCP Auth Secrets
#
# This script generates secure random secrets for MCP OAuth authentication.
# Usage: ./script/generate-mcp-secrets.sh [--k8s]
#
# Options:
#   --k8s    Generate k8s/mcp-auth-secret.yaml for Kubernetes deployment
#   (default) Print environment variables for local .env file

set -e

# Generate secrets
MCP_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
MCP_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
MCP_AUTH_CODE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

if [[ "$1" == "--k8s" ]]; then
  # Generate Kubernetes secret YAML
  OUTPUT_FILE="k8s/mcp-auth-secret.yaml"

  echo "Generating Kubernetes secret: $OUTPUT_FILE"

  cat > "$OUTPUT_FILE" << EOF
apiVersion: v1
kind: Secret
metadata:
  name: mcp-auth-secret
  namespace: collab
type: Opaque
stringData:
  MCP_JWT_SECRET: $MCP_JWT_SECRET
  MCP_REFRESH_SECRET: $MCP_REFRESH_SECRET
  MCP_AUTH_CODE_SECRET: $MCP_AUTH_CODE_SECRET
EOF

  echo "✅ Created $OUTPUT_FILE"
  echo ""
  echo "To apply this secret to your cluster:"
  echo "  kubectl apply -f $OUTPUT_FILE"
  echo ""
  echo "⚠️  IMPORTANT: This file contains secrets! Add it to .gitignore if not already present."

else
  # Print environment variables for .env file
  echo "Generating MCP authentication secrets..."
  echo ""
  echo "Add these to your .env file:"
  echo ""
  echo "MCP_JWT_SECRET=$MCP_JWT_SECRET"
  echo "MCP_REFRESH_SECRET=$MCP_REFRESH_SECRET"
  echo "MCP_AUTH_CODE_SECRET=$MCP_AUTH_CODE_SECRET"
  echo ""
  echo "For Kubernetes deployment, run:"
  echo "  ./script/generate-mcp-secrets.sh --k8s"
fi

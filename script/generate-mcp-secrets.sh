#!/bin/bash
# Generate MCP Auth Secrets
#
# This script generates secure random secrets for MCP OAuth authentication.
# Usage: ./script/generate-mcp-secrets.sh

echo "Generating MCP authentication secrets..."
echo ""
echo "Add these to your .env file:"
echo ""
echo "MCP_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo "MCP_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo "MCP_AUTH_CODE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo ""
echo "For Kubernetes deployment, create a secret:"
echo ""
echo "kubectl create secret generic mcp-auth-secret \\"
echo "  --from-literal=mcp-jwt-secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \\"
echo "  --from-literal=mcp-refresh-secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \\"
echo "  --from-literal=mcp-auth-code-secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \\"
echo "  -n collab"

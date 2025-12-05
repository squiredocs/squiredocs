# Google OAuth Authentication in Kubernetes

This guide explains how to configure Google OAuth authentication for the collaborative editor when running in Kubernetes (Minikube or GKE).

## Prerequisites

- Kubernetes cluster running (Minikube or GKE)
- `kubectl` configured to access your cluster
- Access to [Google Cloud Console](https://console.cloud.google.com/)

## Overview

The authentication system requires:
1. **Google OAuth credentials** (Client ID and Secret)
2. **JWT secrets** for signing access and refresh tokens
3. **Database migration** to create the users table

## Step 1: Create Google OAuth Credentials

### 1.1 Set Up in Google Cloud Console

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create a new project or select an existing one
3. Click **Create Credentials → OAuth client ID**
4. Select **Web application**
5. Configure the OAuth consent screen if prompted

### 1.2 Configure Authorized URLs

Add these URLs based on your environment:

**For Minikube Development (port-forwarded):**
```
Authorized JavaScript origins:
  - http://127.0.0.1:4567
  - http://localhost:4567

Authorized redirect URIs:
  - http://127.0.0.1:4567/auth/google/callback
  - http://localhost:4567/auth/google/callback
```

**For Minikube NodePort (direct access):**
```
Authorized JavaScript origins:
  - http://<minikube-ip>:30173

Authorized redirect URIs:
  - http://<minikube-ip>:30173/auth/google/callback
```

Get your Minikube IP with: `minikube ip`

**For Production (with domain):**
```
Authorized JavaScript origins:
  - https://your-domain.com

Authorized redirect URIs:
  - https://your-domain.com/auth/google/callback
```

### 1.3 Copy Your Credentials

After creating, copy:
- **Client ID** (looks like: `123456789-abc...apps.googleusercontent.com`)
- **Client Secret** (looks like: `GOCSPX-...`)

## Step 2: Create Kubernetes Secret

Create a secret file `k8s/auth-secret.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: auth-secret
  namespace: collab
type: Opaque
stringData:
  # Google OAuth credentials
  google-client-id: "YOUR_GOOGLE_CLIENT_ID"
  google-client-secret: "YOUR_GOOGLE_CLIENT_SECRET"
  
  # JWT secrets - generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  access-token-secret: "YOUR_ACCESS_TOKEN_SECRET_MIN_32_CHARS"
  refresh-token-secret: "YOUR_REFRESH_TOKEN_SECRET_MIN_32_CHARS"
```

**Generate secure JWT secrets:**
```bash
# Generate access token secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate refresh token secret  
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Apply the secret:**
```bash
kubectl apply -f k8s/auth-secret.yaml
```

> ⚠️ **Important:** Add `k8s/auth-secret.yaml` to `.gitignore` - never commit secrets to version control.

## Step 3: Update Deployment Configuration

Add the following environment variables to your deployment (e.g., `k8s/app-dev.yaml`):

```yaml
env:
  # ... existing env vars ...
  
  # Google OAuth
  - name: GOOGLE_CLIENT_ID
    valueFrom:
      secretKeyRef:
        name: auth-secret
        key: google-client-id
  - name: GOOGLE_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: auth-secret
        key: google-client-secret
  - name: GOOGLE_REDIRECT_URI
    value: "http://127.0.0.1:4567/auth/google/callback"  # Adjust for your setup
  
  # JWT Secrets
  - name: ACCESS_TOKEN_SECRET
    valueFrom:
      secretKeyRef:
        name: auth-secret
        key: access-token-secret
  - name: REFRESH_TOKEN_SECRET
    valueFrom:
      secretKeyRef:
        name: auth-secret
        key: refresh-token-secret
  
  # Client URL (for CORS and redirects)
  - name: CLIENT_URL
    value: "http://127.0.0.1:4567"  # Adjust for your setup
```

**Apply the updated deployment:**
```bash
kubectl apply -f k8s/app-dev.yaml
```

## Step 4: Run Database Migration

The users table must be created before authentication will work.

```bash
# Connect to the pod
kubectl exec -it deployment/app-dev -n collab -- sh

# Run migration
cd /local-dev
npm run migrate
```

Expected output:
```
> Migrating files:
> - 003_create_users_table
### MIGRATION 003_create_users_table (UP) ###
CREATE TABLE "users" ...
Migrations complete!
```

## Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud Console | `123...apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | `GOCSPX-...` |
| `GOOGLE_REDIRECT_URI` | Callback URL for OAuth flow | `http://localhost:4567/auth/google/callback` |
| `ACCESS_TOKEN_SECRET` | Secret for signing access JWTs (min 32 chars) | Random hex string |
| `REFRESH_TOKEN_SECRET` | Secret for signing refresh JWTs (min 32 chars) | Random hex string |
| `CLIENT_URL` | Frontend URL for CORS and redirects | `http://localhost:4567` |

## Troubleshooting

### "redirect_uri_mismatch" Error

The redirect URI in your request doesn't match what's configured in Google Cloud Console.

**Fix:** Add the exact URI shown in the error to your OAuth client's "Authorized redirect URIs" in Google Cloud Console.

### "Google OAuth credentials not configured" Error

The environment variables aren't being loaded in the pod.

**Fix:**
```bash
# Verify the secret exists
kubectl get secret auth-secret -n collab

# Verify env vars in pod
kubectl exec deployment/app-dev -n collab -- env | grep GOOGLE
```

### "relation 'users' does not exist" Error

The migration hasn't been run.

**Fix:**
```bash
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run migrate"
```

### CORS Errors

The `CLIENT_URL` doesn't match where the browser is making requests from.

**Fix:** Update `CLIENT_URL` to match your actual frontend URL (including protocol and port).

## Security Notes

1. **Never commit secrets** - Use Kubernetes secrets and keep `auth-secret.yaml` in `.gitignore`
2. **Use HTTPS in production** - The cookie settings automatically enable `secure` flag when `NODE_ENV=production`
3. **Rotate secrets periodically** - Update JWT secrets and increment `token_version` in the database to invalidate existing tokens
4. **Restrict OAuth consent screen** - For internal apps, set the OAuth consent screen to "Internal" to limit access to your organization

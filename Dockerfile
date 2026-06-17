# Build stage for client
FROM node:22-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Production stage
FROM node:22-alpine
WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy package files and install server dependencies
# --chown so the runtime user (appuser) can always read these regardless of the
# host file mode; COPY otherwise preserves source permission bits as root.
COPY --chown=appuser:appgroup package*.json ./
RUN npm ci --only=production && \
    npm install --no-save node-pg-migrate

# Copy server code
COPY --chown=appuser:appgroup server/ ./server/
COPY --chown=appuser:appgroup shared/ ./shared/
COPY --chown=appuser:appgroup migrations/ ./migrations/
COPY --chown=appuser:appgroup script/ ./script/

# Copy built client from builder stage
COPY --from=client-builder --chown=appuser:appgroup /app/client/dist ./client/dist

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server
CMD ["node", "server/index.js"]


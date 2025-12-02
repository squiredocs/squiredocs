# Build stage for client
FROM node:18-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Production stage
FROM node:18-alpine
WORKDIR /app

# Copy package files and install server dependencies
COPY package*.json ./
RUN npm ci --only=production && \
    npm install --no-save node-pg-migrate

# Copy server code
COPY server/ ./server/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

# Copy built client from builder stage
COPY --from=client-builder /app/client/dist ./client/dist

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server
CMD ["node", "server/index.js"]


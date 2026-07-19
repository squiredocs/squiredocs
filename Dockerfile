# Build stage for client
# Base pinned by digest (FR-020) — immutable reference. Digest is the multi-arch
# index for node:22-alpine (resolved 2026-07-15); the tag is kept as a human
# label. Bump both together when updating Node.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
# The patch-package postinstall (patch-package --error-on-fail) needs the patch
# files present BEFORE `npm ci` runs, or it finds zero patches, exits 0, and the
# image silently ships STOCK @tiptap/y-tiptap — the delete-on-catch bug 021
# fixes (feature 021, review CRITICAL-1). Copy patches first, then assert the
# patch actually applied: `--error-on-fail` only catches FAILED applications,
# not absent ones, so an explicit in-image sentinel grep is the real backstop.
COPY client/patches ./patches/
RUN npm ci \
 && grep -q 'SQUIRE-021:' node_modules/@tiptap/y-tiptap/dist/y-tiptap.js \
 && grep -q 'SQUIRE-021:' node_modules/@tiptap/y-tiptap/dist/y-tiptap.cjs \
 || { echo 'FATAL: @tiptap/y-tiptap 021 patch not applied in the image build'; exit 1; }
COPY client/ ./
# Client source imports from ../shared (svg-sanitizer), so the shared dir must
# exist in the builder stage too (it's also copied into the runtime stage below).
COPY shared/ ../shared/
# The client build's documentation step (scripts/build-documentation.mjs) reads
# the markdown page sources from ../documentation at the repo root.
COPY documentation/ ../documentation/
# The client build's blog step (scripts/build-blog.mjs) reads the markdown post
# sources from ../blog at the repo root.
COPY blog/ ../blog/
RUN npm run build

# Production stage
# Same digest-pinned base as the builder (FR-020).
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Fonts for server-side SVG rasterization (@resvg/resvg-js in
# server/mcp/svg-render.js) — without them <text> in SVG blocks renders blank
# when the assistant views a block via the view_svg_blocks chat tool.
RUN apk add --no-cache fontconfig ttf-dejavu

# Copy package files and install server dependencies
# --chown so the runtime user (appuser) can always read these regardless of the
# host file mode; COPY otherwise preserves source permission bits as root.
COPY --chown=appuser:appgroup package*.json ./
# Production deps only. node-pg-migrate is a runtime dependency (the deploy's
# db-migrate Job runs `npm run migrate`), so it lives in "dependencies" and is
# installed here — no separate `npm install` step, which would otherwise pull
# the entire devDependency tree (jest/babel/esbuild/…, ~126MB) into the image.
RUN npm ci --omit=dev && \
    find node_modules -name '*.map' -type f -delete

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


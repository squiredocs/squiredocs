#!/usr/bin/env bash
# `dev` — start the collab dev servers inside the sandbox pod.
# collab's `npm run dev` already runs Express (:3001) and Vite (:5173) together
# via concurrently, so this is a thin, well-named wrapper that lands in the
# workspace first. Baked into the image at /usr/local/bin/dev.
set -euo pipefail
cd "${WORKSPACE:-/local-dev}"
echo "Starting collab dev servers (Express :3001, Vite :5173). Ctrl-C to stop."
exec npm run dev

#!/usr/bin/env bash
# cmd_rebuild.sh — rebuild the dev image, then recreate the pod so it picks up
# the new image. Use after editing image/Dockerfile or image/dev-servers.sh.

main() {
  require_context
  source "$COLLAB_DC_TOOL_DIR/lib/cmd_build.sh"
  build_image
  echo
  echo "Recreating pod with the rebuilt image..."
  exec "$COLLAB_DC_TOOL_DIR/bin/collab-devcontainer" restart "$@"
}

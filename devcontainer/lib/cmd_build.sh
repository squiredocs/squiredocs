#!/usr/bin/env bash
# cmd_build.sh — build the dev image into Minikube's Docker daemon.
# Mirrors collab's script/builddockerdev.sh, but builds the hardened DEV image
# (Claude Code + gh + isolated-vm toolchain) from this tool's image/Dockerfile
# rather than the production Dockerfile in collab.
#
# Exposes image_present() and build_image() so cmd_up/cmd_rebuild can reuse them.

# Returns 0 if the image already exists in Minikube's daemon.
image_present() {
  ( minikube_docker_env && [[ -n "$(docker images -q "$COLLAB_DC_IMAGE" 2>/dev/null)" ]] )
}

build_image() {
  echo "Building $COLLAB_DC_IMAGE into Minikube's Docker daemon..."
  (
    minikube_docker_env
    export DOCKER_BUILDKIT=1
    # Build context is this tool dir so the Dockerfile can COPY image/dev-servers.sh.
    if docker buildx version >/dev/null 2>&1; then
      docker buildx build --progress=plain --load \
        --tag "$COLLAB_DC_IMAGE" --file "$COLLAB_DC_TOOL_DIR/image/Dockerfile" "$COLLAB_DC_TOOL_DIR"
    else
      docker build --tag "$COLLAB_DC_IMAGE" --file "$COLLAB_DC_TOOL_DIR/image/Dockerfile" "$COLLAB_DC_TOOL_DIR"
    fi
  )
  echo "Built $COLLAB_DC_IMAGE."
}

main() {
  require_context
  build_image
}

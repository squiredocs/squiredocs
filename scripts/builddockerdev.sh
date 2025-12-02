#!/bin/bash
set -x

eval $(minikube -p minikube docker-env)

export DOCKER_BUILDKIT=1

# Build collab app image
# Use docker buildx if available, otherwise fall back to docker build
if docker buildx version &>/dev/null; then
  docker buildx build --progress=plain --tag collab:latest --file Dockerfile .
else
  docker build --tag collab:latest --file Dockerfile .
fi


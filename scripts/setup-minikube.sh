#!/bin/bash
set -x

# Create storage classes for minikube
kubectl apply -f k8s/minikube-premium-rwo-sc.yaml
kubectl apply -f k8s/minikube-standard-rwo-sc.yaml

# Label nodes for minikube
kubectl label nodes minikube pool=app --overwrite
kubectl label nodes minikube node-type=cpu-optimized --overwrite

echo "Minikube setup complete!"


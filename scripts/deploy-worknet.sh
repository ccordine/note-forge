#!/bin/sh

set -eu

deployment_context="default"
external_network="worknet_net"
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(dirname -- "$script_directory")

if ! docker --context "$deployment_context" network inspect "$external_network" >/dev/null 2>&1; then
  echo "Refusing NoteForge deployment: external network $external_network is absent from Docker context $deployment_context." >&2
  exit 1
fi

exec docker --context "$deployment_context" compose \
  --project-directory "$project_directory" \
  -f "$project_directory/compose.yaml" \
  up -d --build --wait --wait-timeout 60 app

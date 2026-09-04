#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 <registry/image:tag>" >&2
  echo "Example: $0 ghcr.io/acme/paranovel:1.0.0" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 64
fi

image_ref=$1
platforms=${PLATFORMS:-linux/amd64,linux/arm64}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd -- "${script_dir}/.." && pwd)

image_name=${image_ref##*/}
if [[ -z "${image_ref}" || "${image_ref}" != */* || "${image_name}" != *:* ]]; then
  echo "Error: provide a fully qualified image and tag such as ghcr.io/acme/paranovel:1.0.0." >&2
  exit 64
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is not installed or not available on PATH." >&2
  exit 69
fi

echo "Building and pushing ${image_ref} for ${platforms}"
docker buildx build \
  --platform "${platforms}" \
  --tag "${image_ref}" \
  --push \
  "${project_root}"

echo "Published ${image_ref}"

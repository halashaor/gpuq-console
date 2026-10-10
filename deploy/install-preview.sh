#!/bin/sh
set -eu
command -v node >/dev/null
command -v curl >/dev/null
command -v sha256sum >/dev/null
preview_tmp=$(mktemp -d)
trap 'rm -f "$preview_tmp/gpuctl-preview.mjs"; rmdir "$preview_tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --max-time 180 '__PREVIEW_ORIGIN__/__preview__/gpuctl.mjs' -o "$preview_tmp/gpuctl-preview.mjs"
printf '%s  %s\n' '__PREVIEW_SHA256__' "$preview_tmp/gpuctl-preview.mjs" | sha256sum -c -
node --check "$preview_tmp/gpuctl-preview.mjs"
mkdir -p "$HOME/.local/bin"
if [ -e "$HOME/.local/bin/gpuctl-preview" ] || [ -L "$HOME/.local/bin/gpuctl-preview" ]; then
  printf '%s\n' 'gpuctl-preview already exists; preserve it before reinstalling.' >&2
  exit 1
fi
install -m 700 "$preview_tmp/gpuctl-preview.mjs" "$HOME/.local/bin/gpuctl-preview"
printf '%s\n' 'Installed ~/.local/bin/gpuctl-preview. Stable gpuctl was not changed.' 'Run: ~/.local/bin/gpuctl-preview preview on'

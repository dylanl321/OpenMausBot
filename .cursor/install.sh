#!/usr/bin/env bash
# Cloud Agent bootstrap for OpenMausBot.
#
# The project requires Node 24+ (package.json "engines"), but the Cloud Agent
# runtime injects its own Node 22 at /exec-daemon early in PATH, which shadows
# any Node installed later. The base image's ~/.bashrc prepends the writable
# /usr/local/cargo/bin ahead of /exec-daemon, so we install Node 24 with the
# image's nvm and expose it there. This is idempotent and safe to re-run.
set -euo pipefail

NODE_MAJOR=24

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at $NVM_DIR; cannot provision Node ${NODE_MAJOR}" >&2
  exit 1
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

nvm install "$NODE_MAJOR" >/dev/null
nvm alias default "$NODE_MAJOR" >/dev/null
nvm use "$NODE_MAJOR" >/dev/null

NODE_BIN="$(dirname "$(nvm which "$NODE_MAJOR")")"

# Win the PATH race against the runtime's bundled Node 22.
SHIM_DIR=/usr/local/cargo/bin
if [ -d "$SHIM_DIR" ] && [ -w "$SHIM_DIR" ]; then
  for b in node npm npx corepack; do
    ln -sf "$NODE_BIN/$b" "$SHIM_DIR/$b"
  done
fi
export PATH="$SHIM_DIR:$NODE_BIN:$PATH"

corepack enable
echo "Node: $(node --version) | pnpm: $(corepack pnpm --version)"

corepack pnpm install --frozen-lockfile

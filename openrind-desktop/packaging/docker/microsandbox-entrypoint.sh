#!/usr/bin/env sh
set -eu

OPENRIND_DESKTOP_WORKSPACE="${OPENRIND_DESKTOP_WORKSPACE:-/workspace}"
OPENRIND_DESKTOP_DATA_DIR="${OPENRIND_DESKTOP_DATA_DIR:-/data/openrind-desktop-orchestrator}"
OPENRIND_DESKTOP_SIDECAR_DIR="${OPENRIND_DESKTOP_SIDECAR_DIR:-/data/sidecars}"
OPENRIND_DESKTOP_PORT="${OPENRIND_DESKTOP_PORT:-8787}"
OPENRIND_DESKTOP_OPENCODE_PORT="${OPENRIND_DESKTOP_OPENCODE_PORT:-4096}"
OPENRIND_DESKTOP_TOKEN="${OPENRIND_DESKTOP_TOKEN:-microsandbox-token}"
OPENRIND_DESKTOP_HOST_TOKEN="${OPENRIND_DESKTOP_HOST_TOKEN:-microsandbox-host-token}"
OPENRIND_DESKTOP_APPROVAL_MODE="${OPENRIND_DESKTOP_APPROVAL_MODE:-auto}"
OPENRIND_DESKTOP_CORS_ORIGINS="${OPENRIND_DESKTOP_CORS_ORIGINS:-*}"
OPENRIND_DESKTOP_CONNECT_HOST="${OPENRIND_DESKTOP_CONNECT_HOST:-127.0.0.1}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

mkdir -p "$OPENRIND_DESKTOP_WORKSPACE" "$OPENRIND_DESKTOP_DATA_DIR" "$OPENRIND_DESKTOP_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting OpenrindDesktop micro-sandbox"
printf '%s\n' "- workspace: $OPENRIND_DESKTOP_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- openrind-desktop url: http://$OPENRIND_DESKTOP_CONNECT_HOST:$OPENRIND_DESKTOP_PORT"
printf '%s\n' "- client token: $OPENRIND_DESKTOP_TOKEN"
printf '%s\n' "- host token: $OPENRIND_DESKTOP_HOST_TOKEN"
printf '%s\n' "- health: curl http://$OPENRIND_DESKTOP_CONNECT_HOST:$OPENRIND_DESKTOP_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $OPENRIND_DESKTOP_TOKEN\" http://$OPENRIND_DESKTOP_CONNECT_HOST:$OPENRIND_DESKTOP_PORT/workspaces"

exec openrind-desktop serve \
  --workspace "$OPENRIND_DESKTOP_WORKSPACE" \
  --remote-access \
  --openrind-desktop-port "$OPENRIND_DESKTOP_PORT" \
  --opencode-host 127.0.0.1 \
  --opencode-port "$OPENRIND_DESKTOP_OPENCODE_PORT" \
  --openrind-desktop-token "$OPENRIND_DESKTOP_TOKEN" \
  --openrind-desktop-host-token "$OPENRIND_DESKTOP_HOST_TOKEN" \
  --approval "$OPENRIND_DESKTOP_APPROVAL_MODE" \
  --cors "$OPENRIND_DESKTOP_CORS_ORIGINS" \
  --connect-host "$OPENRIND_DESKTOP_CONNECT_HOST" \
  --allow-external \
  --sidecar-source external \
  --opencode-source external \
  --openrind-desktop-server-bin /usr/local/bin/openrind-desktop-server \
  --opencode-bin /usr/local/bin/opencode \
  --no-opencode-router

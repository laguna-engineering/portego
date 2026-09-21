#!/usr/bin/env bash
#
# Deploys portego on the host. Run as root.
#
#   scripts/deploy.sh [ref]      ref defaults to origin/main
#
# Builds the ref into a new release directory, stops the service, points
# `current` at the new release, migrates, starts, and checks /healthz. A failed
# step restores the previous release before exiting non-zero.
set -euo pipefail
umask 022

APP_DIR=${APP_DIR:-/srv/portego}
SERVICE=${SERVICE:-portego}
MIGRATE_UNIT=${MIGRATE_UNIT:-portego-migrate}
ENV_FILE=${ENV_FILE:-/etc/portego.env}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3333/healthz}
# A release is around 245 MB, most of it node_modules. Raise this only with
# disk to spare.
KEEP_RELEASES=${KEEP_RELEASES:-2}
BUN=${BUN:-/usr/local/bin/bun}
REF=${1:-origin/main}

REPO_DIR="$APP_DIR/repo"
RELEASES_DIR="$APP_DIR/releases"
CURRENT="$APP_DIR/current"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -d "$REPO_DIR/.git" ] || fail "$REPO_DIR is not a git clone. See docs/deployment.md."
[ -r "$ENV_FILE" ] || fail "$ENV_FILE is missing or unreadable"
[ -x "$BUN" ] || fail "$BUN is missing. Set BUN to the pinned Bun binary."

PREVIOUS=""
if [ -L "$CURRENT" ]; then PREVIOUS=$(readlink -f "$CURRENT"); fi

# Points `current` at $1 with a rename, so no reader ever sees it absent.
point_current_at() {
  ln -sfn "$1" "$CURRENT.tmp"
  mv -T "$CURRENT.tmp" "$CURRENT"
}

restore_previous() {
  if [ -z "$PREVIOUS" ]; then
    log "no previous release to restore"
    return
  fi
  log "restoring $PREVIOUS"
  point_current_at "$PREVIOUS"
  systemctl restart "$SERVICE" || true
}

log "fetching $REF"
git -C "$REPO_DIR" fetch --prune --tags origin
SHA=$(git -C "$REPO_DIR" rev-parse --verify "${REF}^{commit}") || fail "unknown ref $REF"
RELEASE="$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$REPO_DIR" rev-parse --short "$SHA")"

if [ -e "$RELEASE" ]; then fail "$RELEASE already exists"; fi
log "building $SHA into $RELEASE"
mkdir -p "$RELEASE"
# A git archive gives a clean tree with no .git directory and no local edits.
git -C "$REPO_DIR" archive --format=tar "$SHA" | tar -x -C "$RELEASE"
echo "$SHA" > "$RELEASE/.release-sha"

# The service reads only dist/, but `bun run migrate` runs src/server/migrate.ts,
# so the source tree and node_modules stay in the release.
(cd "$RELEASE" && "$BUN" install --frozen-lockfile && "$BUN" run build)

log "stopping $SERVICE"
systemctl stop "$SERVICE"

point_current_at "$RELEASE"

log "applying migrations"
if ! systemctl start "$MIGRATE_UNIT"; then
  journalctl -u "$MIGRATE_UNIT" -n 40 --no-pager >&2 || true
  restore_previous
  fail "migration failed. The previous release is running again."
fi

log "starting $SERVICE"
if ! systemctl start "$SERVICE"; then
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  restore_previous
  fail "the service did not start. The previous release is running again."
fi

log "checking $HEALTH_URL"
healthy=false
for _ in $(seq 1 30); do
  # No -S. The service is still binding the port on the first attempt or two,
  # and printing "connection refused" on a deploy that then succeeds reads as a
  # failure. A poll that never succeeds prints the journal below, which says
  # more than curl does.
  if curl -fs --max-time 2 "$HEALTH_URL" | grep -q '"status":"ok"'; then
    healthy=true
    break
  fi
  sleep 1
done

if [ "$healthy" != true ]; then
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  systemctl stop "$SERVICE" || true
  restore_previous
  fail "health check failed. The previous release is running again."
fi

log "pruning old releases, keeping $KEEP_RELEASES"
# shellcheck disable=SC2012
ls -1d "$RELEASES_DIR"/*/ 2>/dev/null | sort -r | tail -n "+$((KEEP_RELEASES + 1))" | while read -r old; do
  old=${old%/}
  [ "$old" = "$RELEASE" ] && continue
  [ "$old" = "$PREVIOUS" ] && continue
  log "removing $old"
  rm -rf "$old"
done

log "deployed $SHA"

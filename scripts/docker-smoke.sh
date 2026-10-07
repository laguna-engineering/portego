#!/bin/sh
# Builds the image and checks what the container depends on: the bundled
# migration, the server starting from dist/ alone under a read-only root, the
# health check, APP_NAME, and a BRANDING_DIR override. Also validates the
# Compose example and its Caddyfile.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
image=portego:smoke
work=$(mktemp -d)
volume=portego-smoke-$$
container=portego-smoke-$$

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker build -t "$image" "$root"

mkdir "$work/branding"
printf 'smoke-mark' > "$work/branding/logo-mark.png"
cat > "$work/env" <<ENV
APP_NAME=Smoke Test
APP_URL=https://share.acme.example
CONTENT_URL=https://content.share.acme.example
SESSION_SECRET=smoke-test-secret-that-is-at-least-32-characters
AUTH_PROVIDERS=google
AUTH_ALLOW_ALL_AUTHENTICATED=true
GOOGLE_CLIENT_ID=smoke
GOOGLE_CLIENT_SECRET=smoke
BRANDING_DIR=/etc/portego/branding
ENV

run() {
  docker run --env-file "$work/env" --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges:true -v "$volume:/var/lib/portego" \
    -v "$work/branding:/etc/portego/branding:ro" "$@"
}

run --rm "$image" bun dist/server/migrate.js
run -d --name "$container" -p 127.0.0.1::3000 "$image" >/dev/null

status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$container")
  [ "$status" = starting ] || break
  sleep 2
done
if [ "$status" != healthy ]; then
  docker logs "$container"
  echo "health check: $status" >&2
  exit 1
fi

port=$(docker port "$container" 3000/tcp | head -n 1 | sed 's/.*://')
base=http://127.0.0.1:$port

curl -fsS -H 'Host: share.acme.example' "$base/" | grep -q '<title>Smoke Test</title>' ||
  { echo "the page does not carry APP_NAME" >&2; exit 1; }
[ "$(curl -fsS "$base/branding/logo-mark.png")" = smoke-mark ] ||
  { echo "the BRANDING_DIR override is not served" >&2; exit 1; }
curl -fsS -o /dev/null "$base/branding/logo-full.png" ||
  { echo "the default logo is not served" >&2; exit 1; }

cd "$root/deploy/docker"
# Compose refuses a missing env_file. Leave an operator's own file in place.
if [ ! -e portego.env ]; then
  touch portego.env
  trap 'rm -f "$root/deploy/docker/portego.env"; cleanup' EXIT
fi
APP_HOST=share.acme.example CONTENT_HOST=content.share.acme.example docker compose config -q
docker run --rm -e APP_HOST=share.acme.example -e CONTENT_HOST=content.share.acme.example \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "container smoke test passed"

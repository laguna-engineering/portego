# Docker

The [`Dockerfile`](../Dockerfile) builds one image that every deployment can
use. Configuration comes from environment variables, branding from a mounted
directory, and data lives on a volume. No registry publishes the image yet, so
build it from a checkout:

```sh
docker build -t portego .
```

[`deploy/docker/`](../deploy/docker) holds a Compose example with the
application, the migration step, and Caddy as the TLS proxy for both
hostnames. [docs/deployment.md](deployment.md) describes the other supported
setup: systemd and nginx on a host.

## What the image contains

The image holds the built client and two bundles, `dist/server/index.js` and
`dist/server/migrate.js`. Both bundles include their dependencies, so the image
has no source tree and no `node_modules`. It runs as the unprivileged `bun`
user and sets these variables:

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | |
| `HOST` | `0.0.0.0` | The default, `127.0.0.1`, is unreachable from outside the container. |
| `PORT` | `3000` | |
| `DATA_DIR` | `/var/lib/portego` | A volume. |
| `CLIENT_DIST` | `dist/client` | Resolved from the working directory, `/app`. |

Leave `HOST` and `CLIENT_DIST` as they are. Set everything else in an
environment file: [.env.example](../.env.example) lists each variable, and the
production values in [docs/deployment.md](deployment.md#5-configuration) apply
unchanged.

The image has a `HEALTHCHECK` on `/healthz`.

## Two hostnames

`APP_URL` and `CONTENT_URL` must use different hostnames, and both must reach
the container through a proxy that passes the `Host` header unchanged. Uploaded
HTML renders on the content host so that it never shares an origin with the
application's cookies. The server refuses to start when the two hosts are the
same. Point both DNS names at the proxy.

## Migrations

The server never changes the schema itself. Run the migration before each
start, with the same environment and volume:

```sh
docker run --rm --env-file portego.env -v portego-data:/var/lib/portego \
  portego bun dist/server/migrate.js
```

It exits once the schema is current, and running it again changes nothing. The
Compose example runs it as the `migrate` service, and the application starts
only after it succeeds. On Kubernetes, run the same command as an init
container.

## Data

`/var/lib/portego` holds the SQLite database and the artifact files. SQLite
allows one writer, so run exactly one container against a volume. Do not scale
the service to more than one replica.

To back up, stop the container so the WAL is checkpointed, then copy the volume
together with the environment file.

## Branding

Mount a directory and set `BRANDING_DIR` to its path in the container:

```sh
docker run ... -e BRANDING_DIR=/etc/portego/branding \
  -v ./branding:/etc/portego/branding:ro portego
```

[docs/branding.md](branding.md) lists the files. Restart the container after
changing one.

## Hardening

The application writes only to `/var/lib/portego`. Run it with a read-only
root filesystem and no capabilities:

```sh
docker run --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true ...
```

The Compose example sets the same options.

## The Compose example

From `deploy/docker/`:

```sh
cp ../../.env.example portego.env    # fill in the production values
printf 'APP_HOST=share.acme.example\nCONTENT_HOST=content.share.acme.example\n' > .env
docker compose up -d
```

`portego.env` configures the application. `.env` gives Caddy the two hostnames,
which must match `APP_URL` and `CONTENT_URL`. Caddy obtains and renews their
certificates, so ports 80 and 443 must be reachable from the internet.

The Caddyfile mirrors [deploy/nginx/portego.conf](../deploy/nginx/portego.conf):

- It passes the `Host` header unchanged.
- It accepts bodies up to 56 MiB on the two upload paths and 6 MiB elsewhere.
  Raise the upload limit when you raise `ARTIFACT_MAX_BYTES` or
  `ARTIFACT_IMAGES_MAX_BYTES`.
- It serves the files in `deploy/docker/mcp-clients/` under `/mcp-clients/`.
  Put a client's metadata document there, as described in
  [docs/mcp.md](mcp.md#hosting-a-metadata-document).
- It sends HSTS, the one security header the application leaves to the proxy.

`docker compose up -d --build` rebuilds the image after a pull, and runs the
migration again before the application restarts.

## Testing the image

`scripts/docker-smoke.sh` builds the image, runs the migration, and starts the
container with a read-only root and a branding override. It then checks the
health status, `APP_NAME` in the page, and the override. It also validates the
Compose file and the Caddyfile. CI runs it on every pull request.

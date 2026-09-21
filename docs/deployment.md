# Deployment

The service runs behind an nginx instance on the same host, which can serve
other sites too. Certificates come from Let's Encrypt through certbot, and the
`certbot.timer` unit the distribution package ships renews them.

Three choices in these files exist for compatibility with older releases:
`listen 443 ssl http2` is used because a separate `http2 on` is a hard error
below nginx 1.25.1, `ProtectProc=` is absent from the units because it needs
systemd 247, and `SystemCallErrorNumber=ENOSYS` is set because the syscall
allowlist holds only the names the host's systemd knows. A syscall newer than
that systemd is missing from the allowlist even when it is ordinary, and the
default action is to kill the process. Bun calls `close_range`, so without the
error number the service dies on start.

## Layout

| Path | Holds |
| --- | --- |
| `/srv/portego/repo` | A git clone the deploy script fetches into |
| `/srv/portego/releases/<stamp>-<sha>` | One built release, owned by root |
| `/srv/portego/current` | Symlink to the running release |
| `/var/lib/portego` | SQLite database and artifact files, owned by the service account |
| `/etc/portego.env` | Configuration and secrets, root-owned, mode 0600 |

The service reads only `dist/` at runtime. `bun run migrate` runs
`src/server/migrate.ts`, so a release keeps its source tree and `node_modules`.

## Disk

A release directory is around 245 MB, most of it `node_modules`. The deploy
script keeps two of them plus the one it is building, so budget about 750 MB.
`KEEP_RELEASES` changes how many survive a deploy.

Check the free space before the first deploy:

```sh
df -h /
journalctl --disk-usage
```

If the journal has grown, reclaim it and cap it so it cannot grow back:

```sh
journalctl --vacuum-size=200M
sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
systemctl restart systemd-journald
```

Building runs `bun install` and Vite on the host. On a machine with 2 GB of RAM
or less, add swap first.

## Host setup

Run every command as root.

### 1. Service account

```sh
useradd --system --home-dir /var/lib/portego --shell /usr/sbin/nologin portego
```

### 2. Bun

Pin the version. `@types/bun` in `package.json` names the version the code is
written against.

```sh
BUN_VERSION=1.4.0
curl -fsSL -o /tmp/bun.zip \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
unzip -j /tmp/bun.zip 'bun-linux-x64/bun' -d /usr/local/bin
chmod 0755 /usr/local/bin/bun
bun --version
```

### 3. Firewall

```sh
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

The service binds `127.0.0.1:3333`, so port 3333 is unreachable from outside
the host whatever the firewall says. The firewall is the second layer.

On a host that runs other services, list every port they need before this
step. `ufw enable` closes every port that is not listed, so it can cut off
services that were reachable a moment before.

### 4. Directories and the repository

```sh
install -d -o root -g root -m 0755 /srv/portego /srv/portego/releases
git clone <repo-url> /srv/portego/repo
```

The deploy script fetches from this clone's `origin`.

`systemd` creates `/var/lib/portego` on first start, through
`StateDirectory=`.

### 5. Configuration

```sh
install -m 0600 /dev/null /etc/portego.env
cat > /etc/portego.env <<'ENV'
NODE_ENV=production
HOST=127.0.0.1
PORT=3333
APP_URL=https://share.acme.example
CONTENT_URL=https://content.share.acme.example
DATA_DIR=/var/lib/portego
CLIENT_DIST=dist/client
SESSION_SECRET=
AUTH_PROVIDERS=google
AUTH_ALLOWED_EMAIL_DOMAINS=acme.example
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_HOSTED_DOMAIN=acme.example
ENV
```

Generate the session secret and paste it in:

```sh
bun -e 'console.log(crypto.randomUUID().replaceAll("-","") + crypto.randomUUID().replaceAll("-",""))'
```

Startup fails with the variable name when a required value is absent.
`SESSION_SECRET` must be at least 32 characters, and `CONTENT_URL` must use a
different host from `APP_URL`. `CLIENT_DIST` must stay relative: the server
resolves it from the working directory, which systemd sets to
`/srv/portego/current`. [.env.example](../.env.example) lists every
variable.

### 6. systemd units

```sh
install -m 0644 /srv/portego/repo/deploy/portego.service /etc/systemd/system/
install -m 0644 /srv/portego/repo/deploy/portego-migrate.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable portego
```

`portego.service` runs the server. `portego-migrate.service` is a
oneshot unit the deploy script starts to apply the schema. Both units read the
environment file as root and drop to the service account, which is why the
environment file can stay mode 0600.

### 7. First deploy

```sh
/srv/portego/repo/scripts/deploy.sh
```

This builds a release, points `current` at it, migrates, and starts the
service. Confirm it before touching nginx:

```sh
curl -s http://127.0.0.1:3333/healthz
```

### 8. DNS

Create an A and an AAAA record for each name:

```
A     share.acme.example          <host-ipv4>
A     content.share.acme.example  <host-ipv4>
AAAA  share.acme.example          <host-ipv6>
AAAA  content.share.acme.example  <host-ipv6>
```

Use a short TTL while setting up, then raise it.

If the DNS provider can proxy traffic, as Cloudflare does, create the records
as DNS only. Two settings have to be right before the proxy is turned on. The SSL/TLS mode
has to be Full (strict): Flexible speaks plain HTTP to the origin, and the port
80 redirect in this configuration would send that request back to the proxy in
a loop. Features that rewrite HTML in flight (Rocket Loader, Auto Minify, Email
Obfuscation) have to be off for the preview host, because a preview has to
serve the bytes that were uploaded.

### 9. Certificates

Both records must resolve to the host before this step.

The nginx file keeps the ACME http-01 path reachable from `/var/www/html`, so
that directory has to exist even though the nginx authenticator does not read
from it.

```sh
install -d -m 0755 /var/www/html
apt install certbot python3-certbot-nginx
certbot certonly --nginx \
  -d share.acme.example \
  -d content.share.acme.example \
  --deploy-hook "systemctl reload nginx"
```

`certonly` obtains one certificate covering both names and leaves the nginx
configuration alone, so the file in this repository stays authoritative. The
deploy hook is recorded in the renewal configuration and reloads nginx after
each renewal.

### 10. nginx

```sh
install -m 0644 /srv/portego/repo/deploy/nginx/portego.conf \
  /etc/nginx/conf.d/portego.conf
nginx -t && systemctl reload nginx
```

This assumes nginx includes `/etc/nginx/conf.d/*.conf`. On a host that uses
the `sites-available` and `sites-enabled` pair, install the file into
`sites-available` and link it from `sites-enabled`.

Replace `share.acme.example` and `content.share.acme.example` in the file with
the real names before installing it.

The proxy preserves the `Host` header, which the application needs: it answers
404 for a `/preview/` path on the application host and for every non-preview
path on the content host, and the MCP endpoint checks the host against a list
built from `APP_URL`. The configuration also forwards `X-Real-IP`,
`X-Forwarded-For`, and `X-Forwarded-Proto`. The application reads none of them
today. nginx is the edge, so its own access log already records the real client
address.

`/api/events` has a location block of its own. It is the one response that
stays open, so buffering is off and the read timeout is an hour, which outlasts
the heartbeat the application writes every 20 seconds. Everything else answers
and finishes under the 60 second timeout on `location /`. The application also
sets `X-Accel-Buffering: no` on that response, so a deployment behind a proxy
nobody edited still delivers events on time.

The stream is fanned out inside the process. One `bun` process serves
everything and there is no shared bus, so a listener reaches every connected
client because every client is connected to that one process. Running a second
process, or a second host behind this proxy, would break live updates quietly:
a change made on one process would never reach a client connected to the other.
Adding either means adding a bus both can read first. The assumption is
recorded in `src/server/events/bus.ts`.

Verify the host split end to end:

```sh
curl -si https://share.acme.example/healthz | head -1   # 200
curl -si https://content.share.acme.example/healthz | head -1  # 404
curl -si http://share.acme.example/ | head -1           # 301
```

Verify that the stream is not buffered. With a session cookie, this prints the
`retry` line at once and a keep-alive comment every 20 seconds. Output that
arrives only when the command is interrupted means the proxy is holding it:

```sh
curl -N -H "cookie: <session-cookie>" https://share.acme.example/api/events
```

## Deploying

```sh
/srv/portego/repo/scripts/deploy.sh              # origin/main
/srv/portego/repo/scripts/deploy.sh v0.2.0       # a tag
/srv/portego/repo/scripts/deploy.sh 1a2b3c4      # a commit
```

The script fetches the ref, extracts it into a new release directory, installs
with a frozen lockfile, builds, stops the service, points `current` at the new
release, migrates, starts, and polls `/healthz` for 30 seconds. A failure at
any step after the build restores the previous release and exits non-zero. The
service is down for the few seconds between the stop and a passing health
check.

Two releases are kept. Set `KEEP_RELEASES` to change that.

## Rolling back

An automatic rollback restores the previous release already. To go back by
hand:

```sh
ls -1 /srv/portego/releases        # pick the target
systemctl stop portego
ln -sfn /srv/portego/releases/<target> /srv/portego/current.tmp
mv -T /srv/portego/current.tmp /srv/portego/current
systemctl start portego
curl -s http://127.0.0.1:3333/healthz
```

Migrations are forward only. A rollback restores the code and leaves the schema
where the newer release put it, so the older release has to tolerate the newer
schema. Additive migrations satisfy this. A migration that drops or renames a
column does not, and needs a database restore instead.

Redeploying an older ref works too, and rebuilds it:

```sh
/srv/portego/repo/scripts/deploy.sh <older-sha>
```

## Logs

```sh
journalctl -u portego -f
journalctl -u portego -n 200 --no-pager
journalctl -u portego-migrate -n 50 --no-pager
systemctl status portego
tail -f /var/log/nginx/error.log
```

The server logs to stdout and stderr, which journald captures. It writes no log
file of its own. Artifact HTML never reaches a log.

## Certificate troubleshooting

Check state and the next renewal:

```sh
certbot certificates
systemctl status certbot.timer
systemctl list-timers certbot.timer
```

Test a renewal without spending a rate limit:

```sh
certbot renew --dry-run
```

Renew now and reload:

```sh
certbot renew --force-renewal
systemctl reload nginx
```

Read the expiry nginx is actually serving, which catches a renewed certificate
that was never loaded:

```sh
echo | openssl s_client -connect share.acme.example:443 \
  -servername share.acme.example 2>/dev/null | openssl x509 -noout -dates
```

If a renewal fails, the usual causes are an A record that moved, port 80 closed
so the http-01 challenge cannot be answered, or the redirect swallowing
`/.well-known/acme-challenge/`. The port 80 block in
[deploy/nginx/portego.conf](../deploy/nginx/portego.conf) serves
that path from `/var/www/html` before the redirect for that reason. Let's
Encrypt rate limits are per registered domain per week, so use `--dry-run`
while debugging.

## Reinstalling the host

The data directory is the only thing that must survive. Back up
`/var/lib/portego` and `/etc/portego.env`. Stop the service before
copying the database, so the WAL is checkpointed.

# portego

A single TypeScript application. [Hono](https://hono.dev) serves the API, and
[Vite](https://vite.dev) builds the React client. Bun runs both.

## Requirements

- [Bun](https://bun.com) 1.4 or later
- Node.js 24 (see `.nvmrc`) if you run editor tooling outside Bun

## Setup

```sh
bun install
cp .env.example .env
```

Fill in `.env`. `SESSION_SECRET` can stay empty in development, but the
admission policy cannot: the server refuses to start when no one could be
admitted. See [docs/authentication.md](docs/authentication.md).

Create the database schema:

```sh
bun run migrate
```

## Development

```sh
bun run dev
```

This starts two processes, plus the local issuer described below when `.env`
points at it:

- Hono on `http://127.0.0.1:3000`
- Vite on `http://127.0.0.1:5173`

Open the Vite URL. Vite forwards `/api`, `/auth`, and `/healthz` to Hono, so
client code uses the same paths in development and in production.

### Signing in without a real provider

A local OpenID Connect issuer signs any visitor in as one fixed person. Point
`.env` at it:

```sh
AUTH_PROVIDERS=oidc
OIDC_ISSUER_URL=http://127.0.0.1:9876
OIDC_CLIENT_ID=test-client-id
OIDC_CLIENT_SECRET=test-client-secret
AUTH_ALLOW_ALL_AUTHENTICATED=true
```

`bun run dev` sees the loopback issuer URL and starts the issuer before the
server, which reads the discovery document at startup and skips the provider
when it cannot. For `bun run dev:server` or `bun run migrate` on their own,
run `bun run dev:issuer` first. `DEV_ISSUER_EMAIL` and `DEV_ISSUER_NAME`
change the person it signs in.

## Production

```sh
bun run build
bun run start
```

`build` writes the client to `dist/client` and the bundled server to
`dist/server`. `start` runs the bundle with `NODE_ENV=production`, serves the
built client, and answers the API on the same port.

Startup fails with a message naming the variable when a required production
value is absent.

[docs/deployment.md](docs/deployment.md) covers a single-host deployment: nginx, the
systemd units, certificates, and the deploy and rollback commands.

## Commands

| Command              | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `bun run dev`        | Start the API and the client dev server     |
| `bun run build`      | Build the client and the server for release |
| `bun run migrate`    | Apply the database schema                   |
| `bun run reconcile`  | Compare artifact metadata with files on disk |
| `bun run start`      | Run the production build                    |
| `bun run typecheck`  | Type-check the whole project                |
| `bun run lint`       | Lint and check formatting                   |
| `bun run lint:fix`   | Apply the safe lint and format fixes        |
| `bun run test`       | Run the server and component tests          |
| `bun run test:server`| Run the server tests                        |
| `bun run test:web`   | Run the component tests, with a DOM         |
| `bun run test:e2e`   | Run the browser tests                       |
| `bun run test:ci`    | Run every suite the way CI does             |

## Environment variables

| Name             | Default        | Notes                                     |
| ---------------- | -------------- | ----------------------------------------- |
| `NODE_ENV`       | `development`  | `development`, `test`, or `production`     |
| `APP_NAME`       | `Portego`      | Shown on the sign-in page and by the OAuth consent screen. |
| `HOST`           | `127.0.0.1`    | Loopback by default. A reverse proxy is the public listener. |
| `PORT`           | `3000`         |                                           |
| `CLIENT_DIST`    | `dist/client`  | Built client directory. Must be a relative path. |
| `SESSION_SECRET` | none           | At least 32 characters. Required when `NODE_ENV=production`. |
| `APP_URL`        | `http://localhost:5173` | Public origin. OAuth callback URLs are built from it. Required when `NODE_ENV=production`. |
| `CONTENT_URL`    | `http://127.0.0.1:5173` | Origin serving artifact previews. Must be a different host from `APP_URL`. Required when `NODE_ENV=production`. |
| `DATA_DIR`       | `data`         | SQLite and artifact files. Production uses `/var/lib/portego`. |
| `ARTIFACT_MAX_BYTES` | `5242880`  | Largest upload accepted, in bytes (5 MiB).  |
| `AUTH_PROVIDERS` | none           | Enabled provider ids, comma separated. Known ids: `google`, `oidc`. |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | none | Domains admitted after authentication. |
| `AUTH_ALLOW_ALL_AUTHENTICATED` | `false` | Admit every authenticated identity. |
| `GOOGLE_CLIENT_ID` | none         | Required when `google` is enabled.        |
| `GOOGLE_CLIENT_SECRET` | none     | Required when `google` is enabled.        |
| `GOOGLE_HOSTED_DOMAIN` | none     | Workspace domain, enforced against the id token `hd` claim. |
| `OIDC_ISSUER_URL` | none          | Issuer or discovery URL. Required when `oidc` is enabled. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | none | Required when `oidc` is enabled. |
| `OIDC_SCOPES`    | `openid profile email` | Scopes the OIDC provider is asked for. |
| `OIDC_LABEL`     | `Single sign-on` | What the sign-in page calls the OIDC provider. |
| `MCP_ALLOW_DYNAMIC_CLIENT_REGISTRATION` | `false` | Let any caller register an OAuth client. |

## Layout

```
src/server/         Hono app, environment parsing, entry point
src/server/auth/    Identity providers, admission policy, session middleware
src/server/artifacts/ Artifact service, HTTP routes, upload validation
src/server/markdown/ HTML to Markdown conversion and its cache
src/server/mcp/    MCP tools, endpoint, and token principal mapping
src/server/preview/ Preview tokens, isolated content responses
src/server/storage/ Artifact metadata, file storage, migrations
src/web/            React client, views, and Vite entry point
deploy/             systemd units and the nginx server configuration
docs/               Design and operation notes
scripts/            Deployment and test entry points
```

## Authentication

Sign-in uses [Better Auth](https://www.better-auth.com). A deployment chooses
which identity providers to enable and, separately, which authenticated
identities to admit. A deployment can enable Google and admit verified
Workspace accounts from one domain, or enable a generic OpenID Connect
provider instead, or as well.

[docs/authentication.md](docs/authentication.md) covers the configuration, the
Google setup and callback URLs, the cookie and CSRF behavior, and how to add a
provider without changing application code.

## Storage

Artifact metadata is in SQLite and the uploaded HTML is on disk, both under
`DATA_DIR`. Uploads are written to a temporary file and linked into place, so a
failed upload leaves neither a partial file nor a row pointing at nothing.
[docs/storage.md](docs/storage.md) covers the data model, the write sequence,
migrations, and the reconciliation report.

## Checks required to merge

Every pull request and every push to `main` runs
[.github/workflows/ci.yml](.github/workflows/ci.yml). Every job has to pass:

**Lint, types, tests, build**

1. `bun install --frozen-lockfile`, so CI installs what the lockfile says
2. `bun run lint` (Biome: lint and formatting)
3. `bun run typecheck`
4. `bun run build`
5. `bun run test:ci`, which runs the server, component, and browser suites

**Dependency audit**

`bun audit --audit-level=high` fails the build on a high or critical advisory.
Everything below that is reported and left to a person to judge. Clearing an
advisory means upgrading, or recording why it does not apply with an explicit
`--ignore` and a comment in the workflow.

**Secrets and deployment details**

[gitleaks](https://github.com/gitleaks/gitleaks) scans the file contents of
every commit, the commit messages, and the pull request title and description
with the rules in [.gitleaks.toml](.gitleaks.toml). Besides credentials, the
rules reject IP addresses outside the documentation ranges, hosting provider
names, and links to agent sessions. Run the same rules before each commit:

```sh
brew install gitleaks   # or another package manager
git config core.hooksPath scripts/git-hooks
```

`bun run test:ci` fails when a test fails **and when a test is skipped**. A
suite that quietly stops running a test is the same problem as a suite that
never had it.

The browser tests need Chromium once:

```sh
bun x playwright install chromium
```

They run the application in the test process, on a real port, serving the built
client. Sign-in uses the same offline provider the server tests use, so nothing
in CI reaches Google, and no test can touch a deployment: every suite builds its
own temporary directory and database. [docs/testing.md](docs/testing.md)
describes the suites and the hostile-artifact cases.

## Web client

Two views. The gallery lists artifacts as cards and keeps its search term in
the URL, so a link reproduces what the sender was looking at. The detail page
shows the metadata, an isolated preview, a source download, and a copy-link
action. Uploading is a dialog that takes a dropped or chosen file, confirms its
name and size, and reports what the server refused when it refuses.

Component tests need a DOM, so `bun run test:web` registers happy-dom first.
`bun test` on its own runs the server tests only.

## Artifact API

`GET`, `POST` under `/api/artifacts` covers listing, upload, metadata, and
source download, and every route there needs a session. `POST /api/uploads`
takes a signed upload ticket instead, for an MCP client sending a file. The
rules live in a transport-independent service that the MCP tools call
directly.
[docs/api.md](docs/api.md) lists the endpoints, the shared error codes, and the
upload limits.

## Status, archiving, and comments

An artifact is open or solved, and can be archived separately, so a solved
artifact can also be archived. The gallery filters on both, archived artifacts
stay out of it unless asked for, and their links keep working. Comments are
append-only: they cannot be edited, and only their author can remove one. Every
change records who made it. See
[docs/collaboration.md](docs/collaboration.md).

## Reading an artifact as text

An artifact can be read as Markdown through the API, the detail page, and MCP.
The HTML is parsed and never executed, so an artifact that draws itself with
JavaScript reports that it has no static content instead of inventing some.
[docs/markdown.md](docs/markdown.md) covers what converts, how URLs are
handled, and the caching rule.

## MCP

Claude and ChatGPT reach the same artifacts through a remote MCP server at
`/mcp`, over Streamable HTTP. This application is also the OAuth authorization
server: tokens are bound to the exact MCP URL, and the tools call the same
artifact service the web routes call. Other clients reach it too, including one
that needs a pre-registered client id rather than dynamic registration.
[docs/mcp.md](docs/mcp.md) covers discovery, scopes, client registration,
hosting a client metadata document, the tools, how a client sends a file
without putting it in a tool argument, and how to connect each client.

## Uploaded HTML

Artifacts are untrusted code that has to render. They are served from a second
hostname, over a short-lived signed URL, into an iframe whose document has an
opaque origin, no cookies, and no network. The application origin never renders
an uploaded document. [docs/security.md](docs/security.md) describes the model,
what each restriction stops, and the known limitations.

## Health check

`GET /healthz` returns `{"status":"ok","uptime":<seconds>}`. It reports no
configuration, secret, or database detail, because the reverse proxy exposes
it publicly.

## License

[Apache License 2.0](LICENSE).

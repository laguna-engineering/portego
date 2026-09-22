# MCP server

Claude and ChatGPT reach the same artifacts as the web client, through a remote
MCP server at `https://share.acme.example/mcp`, using Streamable HTTP.

The tools call the same artifact service the web routes call. Neither transport
has its own rules, and neither can drift from the other.

## Authorization

This application is both the MCP resource server and its authorization server.
Google (or whichever provider the deployment enables) is the upstream sign-in.

- Access tokens are JWTs whose audience is the exact MCP URL. A token minted
  for anything else is refused.
- Every request is verified for signature, issuer, audience, expiry, and scope
  against the keys published at `/api/auth/jwks`.
- Authorization Code with PKCE only.
- A client that listens on the machine registers a portless loopback redirect
  URI and authorizes on whatever port it bound, because the port takes no part
  in the match (RFC 8252). Better Auth 1.7.2 matched the port for the host name
  `localhost`, which refused every sign-in from Claude Code.
- A request without a usable token receives 401 and an RFC 9728
  `WWW-Authenticate` header naming the protected-resource metadata, which is
  how a client discovers where to authorize.

### Discovery

| Document | Path |
| --- | --- |
| Protected resource metadata | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `/.well-known/oauth-authorization-server/api/auth` |
| Keys | `/api/auth/jwks` |

### Scopes

| Scope | Grants |
| --- | --- |
| `artifacts:read` | List and read artifacts. Required for every MCP request. |
| `artifacts:write` | Create artifacts. |
| `offline_access` | A refresh token. The MCP endpoint does not check this scope. |

A token without `artifacts:read` receives a 403 with an `insufficient_scope`
challenge naming what is missing. A read-only token calling `upload_artifact`
gets a tool error saying the same thing.

### Client registration

Client ID Metadata Documents are the supported way to register: the client id
is an HTTPS URL, and this server fetches the document there. The fetch is
restricted to HTTPS, follows no redirects, times out in five seconds, and
stops reading a document as soon as it goes over 64 KiB.

Dynamic Client Registration is off. A client that cannot use metadata documents
needs `MCP_ALLOW_DYNAMIC_CLIENT_REGISTRATION=true`, which lets anyone who can
reach the endpoint create a client record. The rate limits Better Auth applies
to the registration endpoint stay in force, but open registration is still a
larger surface than metadata documents, so leave it off unless a client you
need actually requires it.

A metadata document creates no database row. The server fetches it on each
authorization request and uses it for that flow only, so a client that
registers this way leaves nothing behind.

### Hosting a metadata document

A client that accepts a pre-registered client id needs its document served
somewhere the authorization server can fetch it: over HTTPS, with no redirect,
and without a session. The application serves only `/assets/` from disk and
answers every other path with `index.html`, so the document cannot go in a
release. `deploy/nginx/portego.conf` serves one per client from an exact
`location =` block instead.

The document's `client_id` has to be its own URL. For a client whose callback
is a loopback address:

```json
{
  "client_id": "https://<app-host>/mcp-clients/<name>.json",
  "client_name": "<what the consent screen should say>",
  "redirect_uris": ["http://localhost:<port>/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "artifacts:read artifacts:write offline_access"
}
```

Leave the port out of a loopback `redirect_uris` entry when the client picks
its callback port at run time. The port takes no part in the match, so one
portless entry covers every port the client can bind.

Keep `offline_access` in `scope`, and request it when authorizing. The token
endpoint issues a refresh token only for that scope, and the server refuses a
request for a scope the document does not list. An access token lasts one
hour. A refresh token lasts seven days, and each refresh replaces it with a new
one, so a client stays signed in until it goes a week without use.

Install it on the host and add the matching `location =` block:

```sh
install -d -m 0755 /var/www/html/mcp-clients
install -m 0644 <document> /var/www/html/mcp-clients/<name>.json
nginx -t && systemctl reload nginx
```

`client_name` is what the consent screen shows the person approving the
client, so make it name the client honestly.

### Identity

The token's subject decides who the caller is. A user id in tool arguments is
ignored. The admission policy runs again on every MCP request, so removing a
domain from the allowlist stops the tokens issued under it, without waiting for
them to expire.

### Hosts and origins

The endpoint answers for the application hostname only, and rejects a request
whose `Host` or `Origin` header names anything else. A reverse proxy in front
of it has to pass the browser's `Host` through unchanged.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_artifacts` | Cursor, limit, optional query and sort. Returns compact metadata and web URLs. |
| `get_artifact_metadata` | One metadata record. |
| `get_artifact_source` | The stored HTML of one version, up to 1 MiB, current by default or the one named by an optional `versionId`. Larger artifacts are refused with their size and a link, rather than truncated. |
| `upload_artifact` | Title, optional description, optional `artifactId` to add a version to an existing artifact, and either self-contained HTML or Markdown, or both. Markdown alone becomes a static HTML page in the Portego style; with HTML, it is the text agents read back. Returns the id, digest, version number, whether the upload created the artifact, and the web URL. |
| `create_upload_ticket` | A short-lived URL and ticket for sending an HTML file directly, without putting it in a tool argument. |
| `set_artifact_status` | Mark an artifact solved or open again, archive it, or both. Records the caller as the actor. |
| `list_artifact_comments` | The comments on one artifact, oldest first, with their authors and the version each was written on. |
| `add_artifact_comment` | Adds a comment as the caller, on the current version by default or the one named by an optional `versionId`, optionally as a reply to a root comment via `parentId`. Comments cannot be edited. |
| `get_artifact_markdown` | The artifact's static content as Markdown, current version by default or the one named by an optional `versionId`. Its `source` says whether the version supplied Markdown or the server generated it from HTML. `empty` says so when a page renders everything from JavaScript. |
| `list_artifact_versions` | An artifact's versions, highest number first. |

Every tool description states that artifact HTML is untrusted, self-contained,
and at most 5 MiB. Artifact HTML is never written to a log.

Uploaded HTML reaching a model is data, never instructions. `get_artifact_source`
says so in its description; a client that passes tool output straight into a
prompt should treat it the way it treats any other fetched document.

## Versions

An artifact can carry more than one version, and the artifact keeps one id
and one url across all of them: a link shared once keeps pointing at the
same place after a later version replaces what it shows. Uploading a
document with the same title as an existing, non-archived artifact adds a
new version to it instead of creating a second artifact. Pass `artifactId`
to target a specific artifact instead of matching by title. A description on
the upload replaces the artifact's description; the title never changes
after the first version.

`upload_artifact` reports which version an upload became: `versionNumber` is
the version's number, and `newArtifact` says whether the upload created the
artifact or added to an existing one. A Markdown upload stores its authored
Markdown on that version and renders it to the version's static HTML. An HTML
upload can carry its own `markdown`, the concise text for agents; without it,
reading the version as Markdown converts the HTML. `list_artifact_versions` lists
an artifact's versions, highest number first. `get_artifact_source` and
`get_artifact_markdown` read the current version by default, or take a
`versionId` to read an older one. A comment carries the id and number of the
version it was written on, so `list_artifact_comments` shows which version
each comment was about even after later versions arrive.

## Uploading a file

A tool call carries JSON, so `upload_artifact` has to put the whole document in
an argument. The client spends context on it, and JSON escaping inflates the
request past a size the service itself would accept. `create_upload_ticket`
moves the bytes off the tool call.

The tool returns a URL, a ticket, and the size limit. The client sends the file
as a multipart form:

```sh
curl -H "Authorization: Bearer <ticket>" \
     -F file=@page.html \
     -F contentType=html \
     -F title="A chart" \
     https://share.acme.example/api/uploads
```

`file` is required. `contentType` is `html` by default or `markdown`. An HTML
file may come with a `markdown` text field, the text agents read back. `title`,
`description`, and `artifactId` are optional and follow the same rules as
`upload_artifact`: a title matching an existing, non-archived artifact's title
adds a version instead of creating one, and `artifactId` targets an artifact
explicitly. Markdown is rendered in the Portego style with raw HTML and images disabled. The response is
`{ artifact, newArtifact }`, where `artifact` is the record the web upload
returns and `newArtifact` says whether the upload created it.

Minting a ticket needs `artifacts:write`, the same scope `upload_artifact`
needs. A ticket is a capability rather than a session:

- It is signed with a key derived from the session secret under its own label.
  A preview token cannot be presented as a ticket, and a ticket cannot be
  presented as a preview token.
- It names one user and creates artifacts as that user. A user id in the form
  is ignored, as it is everywhere else.
- It expires in five minutes.
- It travels in the `Authorization` header rather than in the URL, so a reverse
  proxy's access log does not record it.
- It is not single use. Within its lifetime it uploads as many times as it is
  presented, which is the reason it is short-lived. Whoever holds a ticket can
  already create artifacts through `upload_artifact`, so a replay makes
  duplicates rather than granting anything new.

This path suits a client that can run a command, which is where a file already
sits on disk. A client with no shell has only `upload_artifact`.

## Connecting a client

The server is stateless: each request carries its own token, nothing is kept
between calls, and only `POST` is served. There is no server-initiated event
stream, so a client that insists on one will not work.

**MCP Inspector**

```sh
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP, enter `https://share.acme.example/mcp`, and start
OAuth. The browser completes sign-in with the configured provider, the
consent page lists the requested scopes, and the Inspector receives a token.

**Claude**

Settings → Connectors → Add custom connector. Enter the same URL. Claude opens
a browser window for sign-in and consent.

**Claude Code**

```sh
claude mcp add --transport http portego https://share.acme.example/mcp
```

Claude Code serves the OAuth callback on `http://localhost:<port>/callback` on
the machine it runs on. Over SSH the browser is on the other machine, so that
callback has to reach back. Pin the port and forward it:

```sh
# on the machine running Claude Code
MCP_OAUTH_CALLBACK_PORT=3118 claude
# from the machine with the browser
ssh -L 3118:localhost:3118 <host>
```

Without the forward the browser finishes sign-in and then fails to reach the
callback, which looks like the server redirecting somewhere broken.

**ChatGPT**

Settings → Connectors → Create. Enter the same URL and complete the browser
flow. Write tools need an account whose plan allows them; without that,
`upload_artifact` is unavailable and web upload remains.

**A client with a pre-registered client id**

A client that only does Dynamic Client Registration cannot connect while that
is off. A client that accepts a pre-registered client id can, by pointing at a
metadata document. Pi is one: it reads its servers from
`~/.config/mcp/mcp.json`.

Publish the document first, as described under [Hosting a metadata
document](#hosting-a-metadata-document), then name it as the client id:

```json
{
  "mcpServers": {
    "portego": {
      "url": "https://share.acme.example/mcp",
      "auth": "oauth",
      "oauth": {
        "clientId": "https://share.acme.example/mcp-clients/pi.json",
        "redirectUri": "http://localhost:19876/callback",
        "scope": "artifacts:read artifacts:write offline_access"
      }
    }
  }
}
```

`19876` is Pi's default callback port, and Pi refuses to start on a different
one once a client id is pre-registered, so it appears here. The document may
leave it out: a loopback redirect URI matches on everything but the port.

### Client results

| Client | Registers with | Result |
| --- | --- | --- |
| Claude custom connector | Client ID Metadata Document | Connects with Dynamic Client Registration off. No configuration beyond the URL. |
| Pi | Pre-registered client id naming a metadata document | Connects with Dynamic Client Registration off. A loopback `http://localhost` redirect is accepted. |
| Claude Code | Client ID Metadata Document, `https://claude.ai/oauth/claude-code-client-metadata` | Connects with Dynamic Client Registration off. Needs the callback port forwarded when Claude Code runs over SSH. |
| `tools/portego-upload` | Pre-registered client id naming a metadata document | A local stdio MCP server, for an agent that cannot spend a ticket itself. See below. |
| ChatGPT connector | Not yet run | Record which tools the account's plan exposed. |
| MCP Inspector | Not yet run | |

A client that only does Dynamic Client Registration fails at registration with
the server as configured, and reports that the authorization server does not
support it. Such a client needs either a metadata document and a pre-registered
client id, or `MCP_ALLOW_DYNAMIC_CLIENT_REGISTRATION=true`.

### Uploading from an agent that cannot spend a ticket

`create_upload_ticket` assumes the client holding the ticket is a shell that can
spend it. A coding agent usually is not. It runs under a permission layer that
refuses to put a bearer credential on a command line, and refuses to carry a
whole document through a tool argument, so both upload paths are closed to it
and the flow works only for a person at a terminal.

`tools/portego-upload` closes that gap. It is a stdio MCP server that runs on the
same machine as the agent, holds its own token, reads the file itself, and mints
the ticket itself. Its upload and sign-in tools are:

```
upload_artifact_from_path({ path, contentType?, markdownPath?, title?, description?, artifactId? })
sign_in()
```

It also exposes local tools that need no deployment or sign-in:

```
get_artifact_style({ stylePath? })
prepare_artifact_draft({ path, title, template?, stylePath?, overwrite? })
finalize_artifact({ path, outputPath?, stylePath?, maxBytes? })
validate_artifact({ path, maxBytes? })
```

The agent passes paths and receives metadata. Document and embedded font bytes
do not cross the tool boundary. The upload result includes the artifact record
and `newArtifact`, which says whether the upload created the artifact or added
a version to one that already existed.

Its client id names `mcp-clients/claude-code.json`, whose document is in
`tools/portego-upload/`. Install it and its nginx block the same way as any other
client, with `client_id` set to the URL the document is served from.

The tool is the npm package `portego-upload`, so nobody needs a clone of this
repository to use it. It runs on Node 20 or later. In Claude Code, install it as
a plugin from the marketplace in this repository:

```
/plugin marketplace add <owner>/<repository>
/plugin install portego-upload@portego
```

The plugin asks for the address of the deployment, registers the MCP server,
and adds `/portego-upload:share-html` for an existing HTML file,
`/portego-upload:share-markdown` for a Markdown file, and
`/portego-upload:create-artifact` for a new styled document. A new document
is a visual HTML artifact by default; Markdown is for content the user already
has as text, and the server renders it in the same style. Any other MCP
client starts the server with `npx -y portego-upload`, and gives it
`PORTEGO_ORIGIN` in the server entry's `env`. In Claude Code without the plugin,
that is:

```sh
claude mcp add portego-upload --scope user \
  --env PORTEGO_ORIGIN=https://share.acme.example -- npx -y portego-upload
```

Nothing else has to be run by hand. The first upload answers that the user is
not signed in, the agent calls `sign_in`, the browser opens, and the user
approves. `sign_in` takes no address. Only the user names a deployment, so
that nothing an agent reads can point uploads somewhere else. When no
deployment is set at all, the server still starts, and the upload tool answers
with the command the user has to run.

From a terminal, sign in once and name the deployment:

```sh
npx -y portego-upload auth https://share.acme.example
```

That deployment becomes the default, and the tool needs no environment variable
afterwards.

The callback binds a free port the OS picks, and its document registers a
portless loopback redirect to match. Over SSH the browser is on the other
machine, so pin the port and forward it the way Claude Code does:

```sh
PORTEGO_CALLBACK_PORT=8765 npx -y portego-upload auth
```

The token lands in `~/.config/portego/credentials.json` at mode 0600 and
refreshes on its own. The file holds one token for each origin, so a token is
never sent to a deployment that did not issue it.

`PORTEGO_ORIGIN` overrides the default, which is how one project uses another
deployment. Set it where the project's MCP client starts the tool, then run
`auth` with no argument once in that environment. The default stays as it was.
In Claude Code, the `env` block of the server's `.mcp.json` entry does this.
The `env` key of `.claude/settings.json` or `.claude/settings.local.json` also
reaches a stdio server in Claude Code 2, although its documentation does not
promise that. The local file is not committed, so it suits a hostname that
should stay out of the repository:

```json
{ "env": { "PORTEGO_ORIGIN": "https://other.acme.example" } }
```

`PORTEGO_ARTIFACT_STYLE` names an optional style directory or manifest. A
project can instead commit `.portego/artifact-style/`, and a user can keep one
under `~/.config/portego/artifact-style/`. The bundled Portego style is the
fallback. [artifact-styles.md](artifact-styles.md) defines the manifest,
templates, resource embedding, validation, and resolution order.

The same binary creates, validates, and uploads from a terminal:

```sh
npx -y portego-upload prepare report.html --title "Weekly report"
# Edit report.html.
npx -y portego-upload finalize report.html
npx -y portego-upload validate report.portego.html
npx -y portego-upload upload report.portego.html --title "Weekly report" --markdown-file report.md
```

From a clone, `bun run tools/portego-upload/index.ts` takes the same commands.
`bun run build:upload-tool` builds the file the package ships. A tag named
`portego-upload-v<version>` stages it through
`.github/workflows/publish-upload-tool.yml`, and a maintainer then approves the
staged version on npmjs.com, or with `npm stage approve <stage-id>`. Nobody can
install a version before that approval. The workflow holds no npm token:
on npmjs.com the package names this repository and that workflow file as its
trusted publisher, and npm checks the `repository` field of the package against
them. A fork that publishes its own package changes that field.

The automated tests cover the parts that do not need those clients: discovery
documents, the 401 challenge, PKCE authorization through consent to a token,
token audience and issuer, scope enforcement, every tool, argument validation,
creator identity, and admission after a policy change.

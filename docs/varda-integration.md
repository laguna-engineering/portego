# The Varda integration

Varda is a code review runner. It publishes a review page per pull request to
Portego, and the people on the review mark items on that page as entries. With
this integration, Varda learns about those marks, and about pushes to the pull
request, without polling and without accepting incoming connections:

- Portego writes an event to an outbox when an entry changes on a key the page
  marks for Varda, and when GitHub sends a `pull_request` webhook.
- Varda's host keeps one Server-Sent Events stream open to Portego, reads the
  events, and acknowledges each one when it has handled it.

Events carry no entry values and no authors. Varda reads the marks again
through the ordinary API, so the page stays the only record of them.

The integration is off unless the deployment turns it on. With it off, its
routes do not exist and no event is written.

## Configuration

| Variable | Meaning |
| --- | --- |
| `VARDA_ACCOUNT` | The user id of Varda's account. Setting it turns the integration on. |
| `VARDA_GITHUB_WEBHOOK_SECRET` | The webhook secret of the GitHub App, at least 32 characters. Without it, the GitHub endpoint does not exist. Set without `VARDA_ACCOUNT`, the server refuses to start. |

To find the user id, sign in as Varda's account and open `/api/me`: it is
`user.id`. When Varda's account is a service account (see
[authentication.md](authentication.md#service-accounts)), it cannot sign in;
its user id is the `id` that `GET /api/service-accounts` lists for it.

## Which entry changes become events

A key rule in the page's `portego-entries` schema marks a key for Varda with
`"varda": true`, next to `notify` (see [entries.md](entries.md)):

```json
{ "keys": {
  "status:{item}": { "varda": true, "value": { "enum": ["confirmed", "wrong"] } },
  "viewer": { "value": { "type": "string" } }
} }
```

With the integration off, an upload whose schema has `"varda": true` on any
rule is refused with `INVALID_INPUT`.

An entry change writes one event when all of these are true:

1. The integration is on.
2. The key matches a rule with `"varda": true` in the schema of the artifact's
   current version.
3. Varda's account can read the artifact: it is not private, or Varda's
   account created it.
4. The change sets a new key, sets a value whose JSON differs from the stored
   one, or clears a key that had a value. Writing the same value again writes
   nothing. Writes through a public link count the same as members' writes.

The event is written in the same transaction as the entry.

## Events

Each event has an id that only increases, and JSON data:

```json
{ "type": "entry", "artifactId": "01J…", "key": "status:I-03", "change": "set", "at": "2026-01-02T10:00:00.000Z" }
{ "type": "github", "event": "pull_request", "action": "synchronize", "repo": "acme/app", "pr": 12, "head": "<sha>", "at": "2026-01-02T10:00:00.000Z" }
```

`change` is `set` or `clear`. `repo` is the payload's `repository.full_name`,
`pr` its `pull_request.number`, and `head` its `pull_request.head.sha`.

## Endpoints

### `POST /api/integrations/varda/github`

The GitHub App's webhook URL. GitHub's signature is the only authentication:
`X-Hub-Signature-256` must be `sha256=` and the hex HMAC-SHA256 of the raw body
with the secret.

| Status | When |
| --- | --- |
| 204 | The signature is right. A `pull_request` event writes one event; `ping` and every other event write nothing. |
| 401 | The signature is missing or wrong. |
| 413 | The body is over 1 MiB. |
| 404 | The integration is off, or `VARDA_GITHUB_WEBHOOK_SECRET` is not set. |

The `X-GitHub-Delivery` id is stored with the event, so a redelivery writes
nothing.

### `GET /api/integrations/varda/stream`

Needs `Authorization: Bearer <token>`: the OAuth access token Varda's account
uses for `/mcp`, with the `/mcp` URL as its audience and the `artifacts:read`
scope. A session cookie is not enough.

| Status | When |
| --- | --- |
| 200 | A `text/event-stream`, below. |
| 401 | No valid bearer token. |
| 403 | The token's user is not Varda's account, or is no longer admitted. A service account is refused once it is disabled or expired, or when the token was issued before its key last changed. |
| 404 | The integration is off. |

```
retry: 3000

id: 41
data: {"type":"entry",…}

id: 42
data: {"type":"github",…}

: keep-alive
```

- The stream starts with every event not yet acknowledged, in id order, and
  then sends each new event as it is written.
- `Last-Event-ID` is ignored. Varda handles events for different pull requests
  in parallel and acknowledges them out of order, so an event below the last
  id it saw can still be waiting. A reconnect therefore sends events Varda may
  already hold, and Varda skips ids it has.
- A comment line every 20 seconds keeps an idle connection alive.
- One stream at a time: a new stream closes the one before it.
- Portego closes the stream when the token expires. Varda refreshes the token
  and connects again.

### `POST /api/integrations/varda/ack`

The same bearer rule. The body is `{"ids": [41, 42]}`, 1 to 1000 positive
integers. Portego deletes those events and answers 204. Unknown ids are
ignored; any other body gets 400.

## Retention

Portego deletes events older than 7 days at each stream connect and each
acknowledgement, acknowledged or not. Seven days is also how long a refresh
token lasts: a Varda that was away longer signs in again and looks at every
open pull request when it starts.

## The GitHub App

In the App's settings:

- Webhook: active, with the URL `https://share.acme.example/api/integrations/varda/github`,
  content type `application/json`, and the secret.
- Events: "Pull requests".

## The proxy

The stream stays open for up to the token's lifetime. Behind nginx, give it a
location like the one for `/api/events`, with buffering off and a long read
timeout; `deploy/nginx/portego.conf` has both. Caddy needs no rule.

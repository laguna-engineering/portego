# Isolating uploaded HTML

An artifact is untrusted code. It arrives from a person, it runs its own
JavaScript, and the point of this service is that it renders. The design keeps
that from mattering.

## Two hostnames

| Host | Serves |
| --- | --- |
| `share.acme.example` | The application, the API, authentication, and MCP |
| `content.share.acme.example` | Artifact previews, and nothing else |

One process answers both. A request is checked against the hostname it asked
for: the content host serves `/preview/...` and answers 404 for everything
else, and the application host answers 404 for `/preview/...`. Uploaded HTML
therefore never renders on the origin that holds the session.

Session cookies carry no `Domain` attribute, so they are host-only and the
browser never sends them to the content host. The preview route reads no
cookie in any case.

In development the two origins are `http://localhost:5173` and
`http://127.0.0.1:5173`. The browser treats those as different hosts with
separate cookie jars, which reproduces the production separation without a
second DNS name. The Vite proxy passes the browser's `Host` header through for
`/preview`, and a production reverse proxy has to do the same.

## Preview URLs

The application mints a preview URL for a signed-in user who can already see
the artifact. The token in it:

- is signed with a key derived from `SESSION_SECRET`, not with the session key
  itself,
- names one artifact and one of its versions, and both ids are part of what
  is signed,
- expires five minutes after it is issued,
- carries no session and grants nothing else. The API accepts session cookies
  only, so a preview token cannot be presented to it.

An invalid, expired, forged, or swapped token gets the same refusal, which says
nothing about whether the artifact exists.

## Preview response

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:;
  style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:;
  connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none';
  form-action 'none'; base-uri 'none'; object-src 'none';
  frame-ancestors https://share.acme.example; sandbox allow-scripts
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), microphone=(), …
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: same-site
Cache-Control: private, no-store
```

`sandbox allow-scripts` without `allow-same-origin` is what makes the rest
meaningful: the document lands in an opaque origin with no cookies, no storage,
and no access to the page framing it. The browser also applies the `sandbox`
attribute on the iframe, so both the framing page and the response ask for the
same restriction.

Artifacts are self-contained, so every resource they need is inline or a
`data:`/`blob:` URL and nothing has to be fetched. `unsafe-eval` is allowed
because bundlers emit code that needs it; inside an opaque origin with no
network it gives a document nothing it did not already have over its own bytes.

The document is served as uploaded, plus one inline script at the end of its
head: the comment bridge described below. Nothing else rewrites or sanitizes
it. The headers are what make it harmless.

## The comment bridge

A comment can point at a passage of the rendered artifact. The page framing
the preview cannot read a selection made inside an opaque origin, so the
server adds `src/server/preview/bridge.ts` to every preview. It reports the
selected text (the quote and a few characters on each side), where that
selection sits in the frame so the page can put a control beside it, and
paints highlights for existing comments, over `postMessage` and nothing else.

The document is still untrusted, and it can remove, replace, or imitate the
bridge. That grants it nothing:

- The application accepts messages only from the frame's own window, checks
  the shape of each one, and cuts every string to a fixed length
  (`src/web/preview-bridge.ts`). A message is a suggestion for a passage, never
  an action: a comment exists only when the person writes and posts it.
- What the application sends the frame is a mode flag, the quotes of comments
  the reader can already see, and comment ids. No token, session, or account
  detail crosses.
- The bridge does not change what the document can reach. The headers above
  still apply to it, and the frame still has no origin, storage, or network.

## What each restriction stops

| Attempt | What stops it |
| --- | --- |
| Read the framing page's DOM | Opaque origin from `sandbox` without `allow-same-origin` |
| Read cookies or storage | Opaque origin, and a host-only cookie the browser never sends here |
| Call the application API | `connect-src 'none'`, no cookie, and a different origin |
| Submit a form | `form-action 'none'` and no `allow-forms` |
| Open a window | No `allow-popups` |
| Navigate the top page | No `allow-top-navigation` |
| Register a service worker | `worker-src 'none'`, and an opaque origin cannot register one |
| Load a remote script, image, or font | `default-src 'none'` with only inline and `data:`/`blob:` allowed |
| Frame another page | `frame-src 'none'` and `child-src 'none'` |
| Rewrite relative URLs | `base-uri 'none'` |
| Use a preview link for another artifact | The artifact id is signed into the token |
| Reuse an old link | Five-minute expiry |

`src/server/preview/fixtures/hostile.ts` holds a document for each attempt.
The route tests assert that each one is served with the headers above and is
returned as uploaded, with only the bridge added. The browser tests in #10 drive the same documents in a real
browser, which is where the enforcement itself is observed.

## The artifact page

`/a/<id>` is a page on the application origin holding the masthead and one
frame under it. The frame is `ArtifactPreview`, so the artifact reaches the
browser the same way a preview does: a short-lived signed URL on the content
host, `sandbox allow-scripts` on both the attribute and the response.

The masthead sits outside the frame and the frame cannot reach it. An artifact
can still draw a masthead of its own inside the frame and invite a click on it,
so the real one keeps its border and the page background around it.

The gallery reaches this page through a plain card link with no `target`. A
left click stays in the tab and the application routes it. A modified click is the
reader's own, and `rel="noopener noreferrer"` covers the tab the browser opens
for it.

The artifact is framed here rather than opened directly at its preview URL,
and the reason is narrow. A sandboxed document that is itself the top-level
page can navigate its own tab to any URL. `allow-top-navigation` stops a
sandboxed document from navigating a top-level context it is not, and a
top-level document navigating itself is outside what the flag covers. No CSP
directive fills the gap either; `navigate-to` was removed from the
specification. So a tab pointed straight at a preview URL can be turned into
any page by the artifact in it, seconds after the user clicked a link in a
trusted application.

Framing the artifact inside a page on the application origin keeps the
restriction: the document is no longer the top-level context, and the tab stays
where the user put it. The browser tests in `e2e/sandbox.test.ts` run the
hostile documents through this route as well as through the preview URL.

The wrapper page carries the masthead and nothing else of the application. The
reader's own email is on it, and the opaque origin the frame runs in is what
keeps the frame from reading it. `frame-ancestors` already names the application
origin, which is where the wrapper is served.

The server also sets Open Graph and Twitter card tags on `/a/<id>`, so a link
to the page unfurls in chat apps. An unfurler sends no cookie. An anonymous
request gets the artifact's title and the Portego logo, and none of
its content. A signed-in request also gets a description: the artifact's own
description, or the opening of its Markdown text. An archived or unknown id
gets the generic Portego tags.

Anyone who holds a link to an artifact can therefore read its title, and can
tell whether the id exists. Artifact ids are UUIDv7 with 74 random bits, so a
title is visible only to someone who was given the link.

## Known limitations

- A preview URL is a capability. Anyone holding it can read that one artifact
  for five minutes. It should be treated like any other short-lived link.
- Nothing stops a person from copying a preview URL out of the page and opening
  it directly, which gives up the framing described above for those five
  minutes. The application never produces such a link itself.
- An artifact can still consume CPU and memory in the tab that renders it. The
  sandbox limits what it can reach, not what it can spend.
- The protections are browser-enforced. A client that ignores CSP, or an
  outdated browser, does not get them.
- `unsafe-inline` and `unsafe-eval` are deliberate. They are what lets a
  self-contained artifact run at all, and the opaque origin is what makes them
  acceptable.
- Uploaded HTML is never executed on the server.

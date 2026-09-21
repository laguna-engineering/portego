# Tests

Three suites, all run by `bun run test:ci`.

| Suite | Command | What it covers |
| --- | --- | --- |
| Server | `bun run test:server` | Storage, artifact service and API, authentication and admission, previews, MCP, Markdown |
| Component | `bun run test:web` | React views, with happy-dom |
| Browser | `bun run test:e2e` | The whole application in Chromium |

A failing test fails the run, and so does a skipped or todo one: a suite that
quietly stops running a test is the same problem as a suite that never had it.
The runner also fails when it cannot find a summary to read those counts from,
so the rule cannot become a no-op through a change in output format.

## Nothing reaches a real service

No test calls Google, an identity provider, or a deployment.

- The Google provider in tests accepts a locally minted id token. Every claim in
  it, including the hosted domain, goes through the real code path.
- The OpenID Connect tests run against a local issuer that serves a discovery
  document and a JWKS and signs real tokens with a generated key.
- The MCP tests complete a real OAuth flow against the application itself, on a
  port it opened.
- Every suite builds its own temporary directory and SQLite database, so no test
  can read or change anything a deployment owns.

## The browser suite

`bun run test:e2e` builds the client, starts the application in the test
process on a real port, and drives Chromium against it. The content host is the
same listener under a different hostname, which is what the browser needs to
treat previews as a separate origin.

It covers the sign-in boundary (an anonymous browser sees the sign-in page and
no artifact, including on a deep link), then the whole flow with a session:
upload through the dialog with a real file, landing on the artifact's page, the
preview rendering from the content host, the gallery listing and search, opening
an artifact full screen from a card click and acting on it from its own
masthead, the source download, the text view, marking an artifact solved, and
commenting.

## Hostile artifacts

`src/server/preview/fixtures/hostile.ts` holds one document per attack, each
reporting what happened into its own body. The browser suite uploads each one,
opens its preview, and reads the outcome out of the frame:

| Attempt | What the test observes |
| --- | --- |
| Read the framing page's DOM | The document reports a blocked access, and the page title is unchanged |
| Read cookies | Reading them throws: an opaque origin has no cookie jar |
| Write to storage | The same |
| Call the application API | The fetch fails and no response arrives from the application host |
| Submit a form | Nothing is delivered to the target |
| Open a window | `window.open` returns null and the context still has one page |
| Navigate the top page | The page's URL is unchanged |
| Register a service worker | The registration is refused |
| Load a remote script or image | No response arrives, and the browser names `csp` as the reason |
| Frame the application | No response arrives from the application host |
| Rewrite URLs with `<base>` | Nothing is fetched from the rewritten host |

A preview link that was never issued, and one pointed at a different artifact,
both receive 403.

A benign self-contained artifact runs its own inline script and renders, which
is what makes the rest of the list meaningful: the sandbox stops the attacks
without stopping the artifacts.

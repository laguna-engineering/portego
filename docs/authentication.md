# Authentication and admission

Two separate decisions run on every sign-in.

1. **Authentication.** An identity provider proves who the person is and
   returns a verified email address plus a stable subject.
2. **Admission.** The deployment decides whether that identity may use this
   installation.

Provider code never decides admission, and admission code never learns which
provider signed the user in. A deployment can swap providers without touching
the access rules, and can change the access rules without touching provider
code.

## Configuration

| Variable | Purpose |
| --- | --- |
| `AUTH_PROVIDERS` | Enabled provider ids, comma separated. Known ids: `google`, `oidc`. |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Admit verified addresses in these domains. |
| `AUTH_ALLOW_ALL_AUTHENTICATED` | `true` admits every authenticated identity. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client credentials. |
| `GOOGLE_HOSTED_DOMAIN` | Google Workspace domain, enforced against the `hd` claim. |
| `APP_URL` | Public origin. Callback URLs are built from it. |
| `SESSION_SECRET` | Signing key. Required in production. |

Startup fails, with every problem listed at once, when an enabled provider has
no credentials, when a provider id is unknown, or when the admission policy
would admit nobody. Open admission has to be requested explicitly: an empty
`AUTH_ALLOWED_EMAIL_DOMAINS` is a configuration error, not permission to let
everyone in.

A deployment that admits one Google Workspace sets:

```sh
AUTH_PROVIDERS=google
AUTH_ALLOWED_EMAIL_DOMAINS=acme.example
GOOGLE_HOSTED_DOMAIN=acme.example
```

## Admission rules

An identity is admitted when all of these hold:

- the provider returned an email address,
- the provider reported that address as verified,
- the domain of that address is on the allowlist, compared after lowercasing
  and after removing a trailing dot.

Comparison is exact on the whole domain. `evil-acme.example`,
`acme.example.evil`, and `mail.acme.example` are all different domains and
none of them is admitted by `acme.example`. An address with
more than one `@` is refused instead of guessed at.

The policy runs when an account is created and again every time a session is
issued. Removing a domain from the allowlist therefore locks out accounts that
were admitted under the previous configuration.

## Google

Create an OAuth client of type **Web application** in the Google Cloud console
for the project that owns the Workspace. Set the consent screen to **Internal**
when the deployment serves a single Workspace: Google then refuses accounts
outside it before the browser ever reaches this application.

Authorized redirect URIs:

| Environment | URL |
| --- | --- |
| Local | `http://localhost:5173/api/auth/callback/google` |
| Production | `https://share.acme.example/api/auth/callback/google` |

Local development goes through the Vite dev server, which proxies `/api` to
Hono, so the browser-visible origin is port 5173 and that is what Google must
be told.

`GOOGLE_HOSTED_DOMAIN` is used twice. It travels to Google as the `hd`
authorization hint, which pre-selects the right Workspace account chooser. It
is also checked against the `hd` claim of the verified id token, because the
hint is part of a URL the user can edit and proves nothing on its own. An
identity that fails the claim check is mapped as unverified, and the admission
policy refuses unverified identities.

The stored identity is the provider id plus the provider's stable subject
(`sub` for Google). Email addresses can be reassigned inside a Workspace, so
they are treated as attributes, never as the identity key.

## Sessions, cookies, and CSRF

Sessions are cookies: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in
production, where Better Auth also adds the `__Secure-` prefix. No `Domain`
attribute is ever set, so the cookie is host-only and is never sent to
`content.share.acme.example`, the isolated host that serves uploaded
artifacts.

The stricter `__Host-` prefix is not used: Better Auth composes cookie names as
`__Secure-<prefix>.<name>` and its own readers expect that shape. The property
`__Host-` guarantees, a cookie that no sibling host can set or receive, is what
the absent `Domain` attribute already provides here.

Mutating requests that carry a cookie must also carry an `Origin` header that
matches `APP_URL`. A cross-site page can make the browser send the cookie, but
it cannot set that header. Requests without a cookie are left alone, so
token-authenticated clients are unaffected.

## OpenID Connect

`oidc` is a generic OpenID Connect provider for a deployment that does not use
Google. Enable it with:

```sh
AUTH_PROVIDERS=oidc
OIDC_ISSUER_URL=https://sso.example.com
OIDC_CLIENT_ID=portego
OIDC_CLIENT_SECRET=…
OIDC_LABEL=Example SSO
```

`OIDC_ISSUER_URL` accepts the issuer or its discovery URL; the
`/.well-known/openid-configuration` suffix is added when it is absent. It has
to be `https` outside local testing. The document is read when the application
starts, so a deployment pointed at an issuer it cannot read fails there rather
than at the first sign-in.

Redirect URI to register with the provider:

| Environment | URL |
| --- | --- |
| Local | `http://localhost:5173/api/auth/callback/oidc` |
| Production | `https://share.acme.example/api/auth/callback/oidc` |

Authorization Code with PKCE is required, and so is id token verification:
signature against the issuer's published keys, plus issuer, audience, expiry,
and the nonce this application generated for that one sign-in. A token minted
for another client, by another issuer, with another key, or for another
sign-in attempt is refused.

Claims map like any other provider: `sub` is the identity, `email` and
`email_verified` feed the admission policy, and `name` is display only. An
issuer that does not report an address as verified produces an identity the
policy refuses.

Both providers can be enabled at once (`AUTH_PROVIDERS=google,oidc`). A person
who signs in through both keeps one account with one identity per provider,
because Better Auth links a second provider to an existing account when the
address is verified on both sides.

### Example: Keycloak

Create a client in the realm with **Client authentication** on, **Standard
flow** enabled, and the redirect URI above. Copy the client id and secret into
the settings, and set `OIDC_ISSUER_URL` to
`https://keycloak.example.com/realms/<realm>`. The realm's discovery document
is what this application reads; nothing else has to be configured here.

### Secrets, and what signing out does not do

`OIDC_CLIENT_SECRET` is a deployment setting. It is never stored in SQLite,
never sent to the browser, and never included in the provider metadata the
sign-in page reads. There is no way to configure a provider at runtime, which
is deliberate: the secret lives where the process gets its environment.

Signing out ends the session here. It does not sign the user out of the
identity provider, and this application does not call an end-session endpoint,
so a fresh sign-in may complete without a password prompt. A deployment that
needs single logout should configure it at the provider.

## Adding a provider

A provider is one module under `src/server/auth/providers/` that satisfies
`ProviderDefinition`:

```ts
export type ProviderWiring =
  | { kind: "social"; options: object }
  | { kind: "oidc"; config: object };

export type ProviderDefinition = {
  id: string;
  defaultLabel: string;
  resolve: (
    source: EnvSource,
  ) =>
    | { ok: true; wiring: ProviderWiring; label?: string }
    | { ok: false; missing: readonly string[] };
};
```

- `id` is the Better Auth provider key and the last segment of the callback
  URL.
- `defaultLabel` is what the sign-in page shows when the deployment configures
  no label of its own. The client asks `GET /api/auth-providers` for the
  enabled ids and labels, so no provider name is written into client code.
- `resolve` reads the provider's own environment variables and returns either
  the wiring or the names of the variables that are missing.

A `social` provider is a built-in Better Auth provider; an `oidc` provider is
one entry in the generic OAuth plugin. Both are signed in through the same
endpoint, so nothing outside these modules has to tell them apart.

Register the definition in `providerRegistry` in
`src/server/auth/providers/index.ts`. Nothing else changes: the admission
policy, the routes, the MCP layer, and the artifact code do not know which
providers exist.

## Testing without a provider

`src/server/auth/testing.ts` builds an auth instance whose Google provider
accepts a locally minted id token. Every claim in that token, including the
hosted domain, is processed by the real code path.

`src/server/auth/providers/mock-issuer.ts` goes further for OpenID Connect: it
is a local issuer that serves a discovery document and a JWKS, and signs real
id tokens with a real key. The conformance tests drive the whole browser flow
against it, so signature, issuer, audience, and nonce checks are exercised
without a public identity service.

## Known limitations

- Signing out ends the session here. It does not sign the user out of the
  identity provider.
- Session revocation is not immediate for the cookie's lifetime unless the
  session row is deleted; there is no separate revocation list.
- Admission is deployment-wide. There are no roles, teams, or per-artifact
  permissions.

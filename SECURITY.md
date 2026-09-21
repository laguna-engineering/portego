# Security policy

## Reporting a vulnerability

Report it privately, through **Report a vulnerability** on the Security tab of
this repository. Please do not open a public issue or pull request for it.

Include the version (a tag or commit, or the version of `portego-upload`), what
an attacker can do, and the shortest steps that show it. Leave out anything from
a real deployment: hostnames, email addresses, tokens, cookies, and uploaded
documents. Use `share.acme.example` where a hostname is needed.

You can expect an answer within 7 days. We will tell you whether we can
reproduce the problem and what we plan to do, and we will credit you in the
advisory unless you ask us not to.

## Supported versions

Fixes go into the latest release of the application and the latest version of
`portego-upload` on npm. Older versions get no fixes.

## Scope

The code in this repository. A deployment that someone else runs is theirs to
secure: report a problem with it to the people who run it.

[docs/security.md](docs/security.md) describes how uploaded HTML is isolated
and what that isolation does not cover.

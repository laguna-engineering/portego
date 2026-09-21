# CLAUDE.md

## Repository visibility

This repository is public. Keep deployment details out of it: commit messages,
pull request descriptions, issues, and committed files.

Host addresses, real hostnames, the hosting provider, OS and package versions,
disk or memory state, and what else runs on a machine belong in the operator's
private notes. Write `<host-ipv4>`, `share.acme.example`, and similar
placeholders in documentation, and give a version constraint as the constraint
itself ("a separate `http2 on` fails below nginx 1.25.1") rather than as an
inventory of what a host runs.

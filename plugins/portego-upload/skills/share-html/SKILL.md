---
name: share-html
description: Publish a self-contained HTML file to the user's Portego deployment and return its link. Use when the user asks to share, publish, or upload an HTML page, report, or artifact to Portego.
---

# Share an HTML file on Portego

1. The file must be self-contained HTML that renders with no network access. If it is not, say so and stop.
2. Call `upload_artifact_from_path` with the absolute path. Pass `title` only when the user gave one. Pass `artifactId` when the user wants a new version of a known artifact.
3. If the tool says the user is not signed in, call `sign_in`, tell the user to approve the request in the browser that opens, and then repeat the upload.
4. If the tool says no deployment is set, give the user the command from the message. Do not guess the address.
5. Reply with the `url` from the result. It stays the same for every later version.

Do not read the file into the conversation. The tool reads it from disk.

---
name: share-markdown
description: Publish or update a Markdown document on the user's Portego deployment, which renders it as a static page in the Portego style. Use when the user has a Markdown file or asks for plain text. For a new document meant to be visual, create-artifact is the default.
---

# Share a Markdown artifact on Portego

1. Call `upload_artifact_from_path` with the absolute Markdown path and `contentType: "markdown"`. Pass `title` when creating an artifact without a top-level Markdown heading. Decide whether this upload is a new artifact or a new version. When the user refers to an existing document, find its id with `list_artifacts` and pass it as `artifactId`; a matching title never adds a version by itself. Before creating an artifact, call `list_artifacts` with the title as `query`. If a similar title exists, ask the user whether they want a new version of it or a separate artifact. If the upload is refused with `TITLE_EXISTS`, ask the same question, then upload again with `artifactId` or with `allowDuplicateTitle: true`. Do not choose for the user. When the user names a folder or tags, find their ids with `list_folders` and `list_tags` and pass `folderId` and `tagIds`. If no folder or tag matches, tell the user and ask which one to use. Leave both out when the user names none.
2. The server renders the Markdown as a self-contained page in the Portego style. Raw HTML and images in the Markdown do not become executable or loaded content, so a document that needs those, or layout Markdown cannot express, is a job for `create-artifact`.
3. If the tool says the user is not signed in, call `sign_in`, tell the user to approve the request in the browser that opens, and repeat the upload.
4. If the tool says no deployment is set, give the user the command from the message. Do not guess the address.
5. Reply with the `url` from the result. It stays the same for every later version.

Do not read the file into the conversation. The tool reads it from disk.

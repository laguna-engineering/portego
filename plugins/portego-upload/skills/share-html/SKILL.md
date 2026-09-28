---
name: share-html
description: Publish a self-contained HTML file to the user's Portego deployment and return its link. Use when the user asks to share, publish, or upload an HTML page, report, or artifact to Portego.
---

# Share an HTML file on Portego

1. Call `validate_artifact` with the absolute path. The file must be self-contained HTML that renders with no network access. The one exception is images loaded as `images/<name>` from an `images/` folder next to the file: the upload embeds those of 16 KiB or less and SVG files, and sends the others as files with the page. If validation reports an error, explain it and stop. Do not modify a file the user only asked to share.
2. Call `upload_artifact_from_path` with the absolute path. Pass `title` only when the user gave one. Decide whether this upload is a new artifact or a new version. When the user refers to an existing document, find its id with `list_artifacts` and pass it as `artifactId`; a matching title never adds a version by itself. Before creating an artifact, call `list_artifacts` with the title as `query`. If a similar title exists, ask the user whether they want a new version of it or a separate artifact. If the upload is refused with `TITLE_EXISTS`, ask the same question, then upload again with `artifactId` or with `allowDuplicateTitle: true`. Do not choose for the user. When the user names a folder or tags, find their ids with `list_folders` and `list_tags` and pass `folderId` and `tagIds`. If no folder or tag matches, tell the user and ask which one to use. Leave both out when the user names none.
3. If the tool says the user is not signed in, call `sign_in`, tell the user to approve the request in the browser that opens, and then repeat the upload.
4. If the tool says no deployment is set, give the user the command from the message. Do not guess the address.
5. Reply with the `url` from the result. It stays the same for every later version.

Do not read the file or its images into the conversation. The tool reads them from disk.

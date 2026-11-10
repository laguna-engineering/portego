# portego-upload

portego-upload is the local tool for
[Portego](https://github.com/laguna-engineering/portego), a self-hosted site where people and agents share HTML and Markdown artifacts. It
creates an artifact in a configurable style, checks that the artifact will
render on Portego, and uploads it to your deployment. An agent runs it as a
stdio MCP server. You can also run each step from a terminal.

It needs Node.js 20 or later and the address of a Portego deployment.

## Sign in

```sh
npx -y portego-upload auth https://share.acme.example
```

A browser opens. When you approve, the tool saves a token for that deployment
and makes the deployment the default, so later commands need no address. The
tool stores tokens in `~/.config/portego/credentials.json`, or under
`$XDG_CONFIG_HOME/portego/` when that variable is set. The file has mode 0600
and holds one token for each deployment. Tokens refresh automatically.

The deployment's operator must serve a client metadata document at
`/mcp-clients/claude-code.json`. This package includes a template,
`claude-code.json`.
[Hosting a metadata document](https://github.com/laguna-engineering/portego/blob/main/docs/mcp.md#hosting-a-metadata-document)
explains how to serve it.

Over SSH, the browser runs on a different machine than the tool. Choose a fixed
callback port, then forward it from the machine with the browser:

```sh
# on the machine that runs the tool
PORTEGO_CALLBACK_PORT=8765 npx -y portego-upload auth https://share.acme.example
# from the machine with the browser
ssh -L 8765:localhost:8765 <host>
```

The tool prints the sign-in URL. Open it in the browser on the other machine.

### Sign an agent in with a service key

On a machine where no person signs in, such as a CI runner or a server, an
agent can sign in with a key pair instead. The deployment must have
`SERVICE_ACCOUNTS=true`.

```sh
npx -y portego-upload service-key enroll https://share.acme.example --name "Review runner"
```

The tool prints an approval URL and a code. An admin of the deployment opens
the URL, checks that the page shows the same code, and approves. The tool then
writes the private key to `~/.config/portego/service-key.json` (mode 0600), or
to `PORTEGO_SERVICE_KEY`. From then on it signs in with that key and never
opens a browser.

The key renews itself when it is older than a day, and each renewal replaces
it on the server, so a copy of the key stops working at the next renewal. A
key that is not renewed for 7 days expires. An agent that can be idle for days
should run this from a daily timer:

```sh
npx -y portego-upload service-key renew
```

When the server refuses the key, the tool says so and stops. The key was
replaced by a copy that renewed first, or an admin disabled the account. Enroll
again, and ask an admin to check the account.

## Use it with an agent

In Claude Code, install the plugin. It contains its own copy of this server and
adds skills that create and share artifacts:

```
/plugin marketplace add laguna-engineering/portego
/plugin install portego-upload@portego
```

When you install it, Claude Code asks for the deployment address. Leave it empty
to use the deployment set with `auth <origin>`.

Other MCP clients start the server with `npx -y portego-upload` and give the
deployment address in `PORTEGO_ORIGIN`. Clients that read an `mcpServers` map,
such as Claude Desktop and Cursor, accept an entry like this one:

```json
{
  "mcpServers": {
    "portego-upload": {
      "command": "npx",
      "args": ["-y", "portego-upload"],
      "env": { "PORTEGO_ORIGIN": "https://share.acme.example" }
    }
  }
}
```

When the server has no token, its tools tell the agent to call `sign_in`, which
opens the browser. `sign_in` takes no address. Only you choose the deployment,
with `auth <origin>` or `PORTEGO_ORIGIN`, so text that an agent reads cannot
send uploads to a different deployment. When no deployment is set, the server
starts anyway, and each tool that needs the deployment replies with the command
you must run.

The tools create a draft in the active style, finalize and validate it, upload
HTML or Markdown, download an artifact's HTML, search and read artifacts, read
and add comments, and list folders and tags.
[docs/mcp.md](https://github.com/laguna-engineering/portego/blob/main/docs/mcp.md#uploading-from-an-agent-that-cannot-spend-a-ticket)
lists them.

## Use it from a terminal

```sh
npx -y portego-upload prepare report.html --title "Weekly report" --template report
# Edit report.html.
npx -y portego-upload finalize report.html
npx -y portego-upload validate report.portego.html
npx -y portego-upload upload report.portego.html --title "Weekly report"
```

| Command | Description |
| --- | --- |
| `auth [origin]` | Signs in. With an address, also makes that deployment the default. |
| `prepare <file> --title T [--template name] [--style path] [--overwrite]` | Writes a draft from one of the style's templates. The bundled style has `report` (the default), `decision`, and `dashboard`. Refuses to replace an existing file unless you pass `--overwrite`. |
| `finalize <file> [--output path] [--style path] [--allow-style-change]` | Embeds the style's CSS and fonts and writes a separate self-contained file, `<name>.portego.html` by default. Refuses to write a file that fails validation. A draft finalizes only with the style that prepared it, unless you pass `--allow-style-change`. |
| `validate <file>` | Checks the file against Portego's rules, such as size, external resources, network calls, and basic accessibility. Prints the result as JSON and exits with status 1 when the file is invalid. |
| `upload <file> [options]` | Uploads an HTML or Markdown file and prints the artifact's URL. |
| `style [path]` | Prints the active style, or the style at `path`, as JSON. |
| `serve`, or no command | Starts the MCP server on stdio. |

`upload` takes these options:

| Option | Effect |
| --- | --- |
| `--title T`, `--description D` | Sets the title and the description. |
| `--markdown` | Uploads the file as Markdown. A file whose name ends in `.md` is Markdown without this option. The deployment renders Markdown as a page in the Portego style. |
| `--markdown-file text.md` | Sends this Markdown with an HTML upload. Agents read it back in place of text parsed from the HTML. |
| `--artifact-id ID` | Adds a new version to that artifact. |
| `--allow-duplicate-title` | Creates a new artifact when another artifact already has the same title. |
| `--folder-id ID` | Files the artifact in that folder. |
| `--private` | Makes the artifact visible only to you. A deployment that does not allow private artifacts refuses the upload. |

An HTML file loads its images as `images/<name>` from an `images/` folder next
to it. `finalize` and `upload` embed every SVG file and every other image of
16 KiB or less. The tool uploads larger PNG, JPEG, GIF, WebP, and AVIF files of
up to 10 MiB with the page.

## Styles

The tool uses the first style it finds in this order:

1. `--style <path>`, or a path that an agent passes to a style tool.
2. `PORTEGO_ARTIFACT_STYLE`, which the Claude Code plugin's style setting also
   sets.
3. `.portego/artifact-style/` in the working directory or one of its parents.
4. `~/.config/portego/artifact-style/`, or
   `$XDG_CONFIG_HOME/portego/artifact-style/` when that variable is set.
5. The Portego style, bundled with the tool.

A style contains instructions for the agent that creates the artifact. Trust a
project style as much as you trust the project's other agent instructions.
[docs/artifact-styles.md](https://github.com/laguna-engineering/portego/blob/main/docs/artifact-styles.md)
defines the style format.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PORTEGO_ORIGIN` | The deployment to use in place of the default. Run `auth` with no argument once to sign in to it. |
| `PORTEGO_ARTIFACT_STYLE` | A style directory or its `manifest.json`. |
| `PORTEGO_CALLBACK_PORT` | The local port for the sign-in callback. By default the OS chooses a free port. |
| `PORTEGO_CREDENTIALS` | The path of the credentials file. |
| `PORTEGO_SERVICE_KEY` | The path of the service key file. |
| `PORTEGO_CLIENT_ID` | The OAuth client id. The default is `<origin>/mcp-clients/claude-code.json`. |

## License

[Apache License 2.0](https://github.com/laguna-engineering/portego/blob/main/LICENSE).

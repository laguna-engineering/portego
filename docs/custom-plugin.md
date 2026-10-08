# A company's own upload plugin

The `portego-upload` plugin and npm package call the product "Portego" in what
Claude and people read: tool titles, skill descriptions, setup messages, and
the default style. A company can build its own copy under its own name, with
its deployment and its style built in, and publish it in its own Claude Code
marketplace and npm scope.

```sh
bun install
bun run generate:upload-tool \
  --name "Acme Share" \
  --slug acme-share \
  --package @acme/share-upload \
  --origin https://share.acme.example \
  --style ./acme-style \
  --out ../acme-share-upload
```

Run it from a checkout of this repository, at the release you want to ship.
The generated tool has that release's version.

## Options

| Option | Required | Effect |
| --- | --- | --- |
| `--name` | yes | The product name in tool titles, skills, messages, the plugin settings, and the bundled style. |
| `--slug` | yes | Lowercase letters, digits, and hyphens. The plugin, its MCP server, and the command are `<slug>-upload`. Finished artifacts are named `<draft>.<slug>.html`. |
| `--package` | no | The npm package name, `<slug>-upload` by default. Messages tell people to run `npx -y <package> auth`. |
| `--origin` | no | The deployment, as an https URL. The tool uses it when a person has not chosen another one, so nobody has to run `auth <origin>` before signing in. |
| `--style` | no | A style directory to use when a person selects none, in place of the Portego style. [docs/artifact-styles.md](artifact-styles.md) defines the format. A style that sets `"extends": "portego"` keeps the Portego templates and CSS and changes what it names. The generator refuses a style the tool cannot load. |
| `--out` | yes | A directory that does not exist yet or is empty. |

## Output

```
acme-share-upload/
  .claude-plugin/marketplace.json     a marketplace with one plugin
  plugins/acme-share-upload/          the plugin: manifest, skills, server
  npm/                                the npm package
  mcp-clients/claude-code.json        with --origin: the client metadata document
```

### The plugin

Push the directory to a git repository and add it as a marketplace:

```
/plugin marketplace add acme/acme-share-upload
/plugin install acme-share-upload@acme-share
```

A company that already runs a marketplace copies `plugins/acme-share-upload/`
into it and adds the entry from `.claude-plugin/marketplace.json` to its own.

### The npm package

The plugin does not need it: it starts the server from its own directory. The
package is for people who run the tool from a terminal or from another MCP
client. Publish it from `npm/`:

```sh
cd npm
npm publish --access public    # or restricted, for a private scope
```

### The client metadata document

The tool registers with the deployment as
`<origin>/mcp-clients/claude-code.json`. With `--origin`, the generator writes
that document. Serve it from the proxy, as
[docs/mcp.md](mcp.md#hosting-a-metadata-document) describes: the Compose
example in [docs/docker.md](docker.md) serves `deploy/docker/mcp-clients/`.

## What keeps the Portego name

These are identifiers, and a renamed build keeps them so that settings,
existing files, and artifacts keep working:

- The environment variables `PORTEGO_ORIGIN`, `PORTEGO_ARTIFACT_STYLE`,
  `PORTEGO_CREDENTIALS`, `PORTEGO_CLIENT_ID`, and `PORTEGO_CALLBACK_PORT`.
- The credentials file `~/.config/portego/credentials.json` and the style
  directories `.portego/artifact-style/` and `~/.config/portego/artifact-style/`.
  Credentials are stored per deployment, so a renamed tool and `portego-upload`
  can share the file.
- The page API an artifact uses: `window.portego` and the `portego:` events.
- The `data-portego-style` and `data-portego-content` markers in drafts, and the
  style id in `"extends": "portego"`.

## Updating

Generate again into a new directory from the new release, and replace the
contents of the marketplace repository and the npm package with it. The tool's
version follows this repository's `tools/portego-upload/package.json`.

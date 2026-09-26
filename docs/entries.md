# Entries

An entry is one person's JSON value for one key on an artifact. Pages use
entries for votes, poll answers, checklists, and proposals. Agents read and
write the same entries through the MCP. Comments stay for discussion between
people.

## The contract

- Each person holds at most one value per key on an artifact. Writing a key
  again replaces that person's value. Other people's values for the key stay.
- A key is 1 to 200 printable ASCII characters with no spaces, such as
  `vote:P-01`.
- A value is any JSON value, at most 4000 bytes as JSON text.
- One person can hold at most 200 keys on one artifact.
- One person can make at most 60 changes a minute to one artifact's entries.
  Past that, a write is refused with `RATE_LIMITED`.
- Entries belong to the artifact, not to a version. A new version keeps them.
- A person can clear only their own values. Clearing a key they never set does
  nothing.

Every change is announced as `entry.changed` on `GET /api/events`.

## In the page

The bridge that Portego adds to every preview gives the page:

| Name | What it is |
| --- | --- |
| `window.portego.entries` | Every entry on the artifact: `{ key, value, authorId, author, updatedAt }`. `author` is a name; `authorId` is an opaque id that tells two people with one name apart. No email reaches the page. |
| `portego:entries` event on `window` | Fired with the same list in `event.detail` when the page loads and after every change, by anyone. |
| `window.portego.set(key, value)` | Asks to set the reader's value for `key`. |
| `window.portego.clear(key)` | Asks to remove the reader's value for `key`. |

The bridge script is added before `</head>`, so a script in `<body>` can use
`window.portego` directly. The entries arrive a moment after load; render from
the `portego:entries` event.

`set` and `clear` are requests. The application makes one only while the
reader's click inside the artifact is still active, and ignores it otherwise,
so a page cannot record anything as whoever opens it. It then shows the reader
what was saved. The result reaches the page as the next `portego:entries`
event; a refused write produces no event and shows the reader an error.

A click on the Portego page itself, such as the one that opens the artifact
from the gallery, activates the page for about 5 seconds, and the application
cannot tell it from a click inside the frame. So for 5 seconds after any
click or key press on the Portego page, writes are ignored. A reader who
clicks in the artifact during that time is asked to click again.

A small poll:

```html
<script type="application/json" id="portego-entries">
{ "keys": { "poll": { "description": "The reader's choice.", "value": { "enum": ["A", "B"] } } } }
</script>
<button data-choice="A">A</button> <button data-choice="B">B</button>
<p id="tally"></p>
<script>
  window.addEventListener("portego:entries", (event) => {
    const votes = event.detail.filter((entry) => entry.key === "poll");
    const count = (choice) => votes.filter((entry) => entry.value === choice).length;
    document.getElementById("tally").textContent = `A: ${count("A")} · B: ${count("B")}`;
  });
  for (const button of document.querySelectorAll("[data-choice]")) {
    button.addEventListener("click", () => window.portego.set("poll", button.dataset.choice));
  }
</script>
```

## The schema

A page may declare the keys it accepts. The schema is optional; without one,
any well-formed key and value is accepted.

```html
<script type="application/json" id="portego-entries">
{
  "keys": {
    "vote:{item}": {
      "description": "One vote per person for an open item. Count distinct authors.",
      "params": { "item": { "enum": ["P-01", "P-02"] } },
      "value": { "const": true }
    },
    "propose:{id}": {
      "description": "A new feature or bug. The curator turns it into an item.",
      "value": {
        "type": "object",
        "required": ["kind", "title"],
        "properties": {
          "kind": { "enum": ["feature", "bug"] },
          "title": { "type": "string", "maxLength": 120 }
        }
      }
    }
  }
}
</script>
```

- `keys` maps key templates to rules. A template is literal text with up to
  three `{name}` placeholders. A placeholder matches one or more characters
  other than `:`, and two placeholders need literal text between them. A key
  takes the first template it matches.
- Each rule may have a `description`, `params` (a rule for each placeholder,
  checked against the matched text), and `value` (a rule for the value).
- A rule supports `description`, `type`, `enum`, `const`, `minLength`,
  `maxLength`, `minimum`, `maximum`, `properties`, `required`,
  `additionalProperties` (`true` or `false`), `items`, `minItems`, and
  `maxItems`, with their JSON Schema meaning. `type` is one of `string`,
  `number`, `integer`, `boolean`, `object`, `array`, and `null`.
- `pattern` is not supported. The server would run a regular expression that
  an uploaded page wrote, and a backtracking one can hold the process for
  minutes on a short input. Use `enum` or length limits instead.
- The schema is at most 16 KiB, with at most 100 key templates.

The upload checks the schema. A schema that is not valid JSON, uses a keyword
outside the list, or breaks a template rule refuses the upload with a message
that says what to fix, so the author finds out before anyone writes.

When the current version declares a schema, a write must match one of its
templates and fit its rules; a write that does not is refused with a message
that names the problem. The current version's schema applies whichever version
the writer is looking at. Entries written before a schema change stay as they
are: the schema is checked on write only, and the page decides how to read
older values.

The schema is written by the page's author, and the page is untrusted, so the
schema keeps honest pages and agents consistent and nothing more. What limits
a page is the click requirement, the rate limit, and the preview sandbox
described in [security.md](security.md).

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/artifacts/:id/entries` | `{ entries, schema }`: every entry, oldest change first, and the current version's schema or `null` |
| `PUT` | `/api/artifacts/:id/entries` | `{ "key": "…", "value": … }` sets the caller's value and returns `{ entry }` |
| `DELETE` | `/api/artifacts/:id/entries?key=…` | Removes the caller's value; `204` whether or not there was one |

Every route needs a session, and the author comes from it.

## MCP

| Tool | Purpose |
| --- | --- |
| `list_artifact_entries` | Every entry with its author, and the current version's schema |
| `set_artifact_entry` | Sets the caller's value for a key |
| `clear_artifact_entry` | Removes the caller's value for a key |

The write tools need the `artifacts:write` scope. Each tool's description
states the contract above, so an agent that has not read this page still has
it. An agent that wants to know what a key means reads the schema's
descriptions from `list_artifact_entries`.

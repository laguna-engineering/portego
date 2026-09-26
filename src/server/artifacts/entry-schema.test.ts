import { describe, expect, test } from "bun:test";
import {
  checkEntry,
  ENTRY_SCHEMA_MAX_BYTES,
  EntrySchemaError,
  extractEntrySchema,
  isEntryKey,
  parseEntrySchema,
} from "./entry-schema.ts";

const BACKLOG = {
  keys: {
    "vote:{item}": {
      description: "One vote per person for an open item.",
      params: { item: { enum: ["P-01", "P-02"] } },
      value: { const: true },
    },
    "propose:{id}": {
      value: {
        type: "object",
        required: ["kind", "title"],
        additionalProperties: false,
        properties: {
          kind: { enum: ["feature", "bug"] },
          title: { type: "string", maxLength: 20 },
        },
      },
    },
    note: { value: { type: "string" } },
  },
};

const backlog = parseEntrySchema(JSON.stringify(BACKLOG));

function refusal(schema: unknown): string {
  try {
    parseEntrySchema(typeof schema === "string" ? schema : JSON.stringify(schema));
  } catch (error) {
    expect(error).toBeInstanceOf(EntrySchemaError);
    return (error as Error).message;
  }
  throw new Error("expected the schema to be refused");
}

describe("extractEntrySchema", () => {
  test("reads the portego-entries block and ignores other JSON scripts", () => {
    const html = `<!doctype html><html><head>
      <script type="application/json" id="data">{"other":1}</script>
      <script type="application/json" id="portego-entries">{"keys":{}}</script>
      </head><body></body></html>`;
    expect(extractEntrySchema(html)).toBe('{"keys":{}}');
  });

  test("finds nothing in a page that declares no schema", () => {
    expect(extractEntrySchema("<!doctype html><p>plain</p>")).toBeNull();
  });

  test("ignores a block with the id but not the JSON type, which the browser would run", () => {
    const html = `<script id="portego-entries">{"keys":{}}</script>`;
    expect(extractEntrySchema(html)).toBeNull();
  });

  test("refuses two blocks, since the browser and the server could each read a different one", () => {
    const block = `<script type="application/json" id="portego-entries">{"keys":{}}</script>`;
    expect(() => extractEntrySchema(block + block)).toThrow("Keep one");
  });
});

describe("parseEntrySchema", () => {
  test("refuses pattern, so the server never runs a regular expression a page wrote", () => {
    const message = refusal({
      keys: { "vote:{item}": { params: { item: { pattern: "^(a+)+$" } } } },
    });
    expect(message).toContain('"pattern" is not supported');
  });

  test("refuses keywords it does not enforce instead of silently ignoring them", () => {
    expect(refusal({ keys: { note: { value: { format: "email" } } } })).toContain('"format"');
    expect(refusal({ keys: { note: { values: {} } } })).toContain('unknown field "values"');
    expect(refusal({ keys: {}, version: 2 })).toContain("unknown field: version");
  });

  test("says what is wrong with a malformed or oversized schema", () => {
    expect(refusal("{not json")).toContain("not valid JSON");
    expect(refusal({ entries: {} })).toContain('"keys"');
    expect(refusal(" ".repeat(ENTRY_SCHEMA_MAX_BYTES + 1))).toContain("larger than");
  });

  test("refuses key templates it could not match unambiguously", () => {
    expect(refusal({ keys: { "{a}{b}": {} } })).toContain("text between them");
    expect(refusal({ keys: { "{a}:{a}": {} } })).toContain("appears twice");
    expect(refusal({ keys: { "a:{b}:{c}:{d}:{e}": {} } })).toContain("at most 3 placeholders");
    expect(refusal({ keys: { "vote {item}": {} } })).toContain("no spaces");
    expect(refusal({ keys: { "vote:{item}": { params: { id: {} } } } })).toContain(
      "names no placeholder",
    );
  });
});

describe("checkEntry", () => {
  test("accepts entries the backlog declares", () => {
    expect(checkEntry(backlog, "vote:P-01", true)).toBeNull();
    expect(checkEntry(backlog, "propose:x1", { kind: "bug", title: "Broken link" })).toBeNull();
    expect(checkEntry(backlog, "note", "anything")).toBeNull();
  });

  test("catches a vote for an item the page does not list, which would otherwise be stored and never counted", () => {
    expect(checkEntry(backlog, "vote:p-01", true)).toContain(
      '{item} must be one of "P-01", "P-02"',
    );
  });

  test("checks the value, including nested fields", () => {
    expect(checkEntry(backlog, "vote:P-01", false)).toBe("value must be true.");
    expect(checkEntry(backlog, "propose:x1", { kind: "idea", title: "x" })).toContain(
      "value.kind must be one of",
    );
    expect(checkEntry(backlog, "propose:x1", { kind: "bug" })).toBe("value.title is required.");
    expect(checkEntry(backlog, "propose:x1", { kind: "bug", title: "x", extra: 1 })).toBe(
      "value.extra is not allowed.",
    );
    expect(checkEntry(backlog, "propose:x1", { kind: "bug", title: "x".repeat(21) })).toContain(
      "at most 20 characters",
    );
  });

  test("treats names like toString as fields, not as rules inherited by every object", () => {
    const fields = JSON.parse('{"kind":"bug","title":"x","toString":"y"}');
    expect(checkEntry(backlog, "propose:x1", fields)).toBe("value.toString is not allowed.");
    const needsConstructor = parseEntrySchema(
      JSON.stringify({ keys: { k: { value: { type: "object", required: ["constructor"] } } } }),
    );
    expect(checkEntry(needsConstructor, "k", {})).toBe("value.constructor is required.");
  });

  test("refuses a key the schema does not declare and names the ones it does", () => {
    const problem = checkEntry(backlog, "poll", "B");
    expect(problem).toContain("matches no key");
    expect(problem).toContain("vote:{item}");
  });

  test("keeps a placeholder inside one colon-separated segment", () => {
    expect(checkEntry(backlog, "propose:a:b", {})).toContain("matches no key");
  });
});

describe("isEntryKey", () => {
  test("accepts printable keys up to the limit and refuses spaces and control characters", () => {
    expect(isEntryKey("vote:P-01")).toBe(true);
    expect(isEntryKey("x".repeat(200))).toBe(true);
    expect(isEntryKey("x".repeat(201))).toBe(false);
    expect(isEntryKey("")).toBe(false);
    expect(isEntryKey("two words")).toBe(false);
    expect(isEntryKey("tab\there")).toBe(false);
  });
});

import { type DefaultTreeAdapterTypes, parse } from "parse5";

type Node = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.Document;

/**
 * An artifact may declare the entries it accepts in a
 * `<script type="application/json" id="portego-entries">` block. The schema is
 * the page author's, so it is untrusted: it only keeps honest pages and agents
 * consistent, and nothing about access depends on it.
 */
export const ENTRY_SCHEMA_ELEMENT_ID = "portego-entries";
export const ENTRY_SCHEMA_MAX_BYTES = 16 * 1024;
export const ENTRY_KEY_MAX_LENGTH = 200;

const MAX_KEY_RULES = 100;
const MAX_PLACEHOLDERS = 3;
const MAX_DEPTH = 8;
const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
/**
 * `pattern` is left out on purpose: the server would run a regular expression
 * written by an untrusted page, and a backtracking one can hold the process for
 * minutes on a short input.
 */
const KEYWORDS = new Set([
  "description",
  "type",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
]);

/** Printable ASCII without spaces, so a key reads the same everywhere it is shown. */
const KEY_SYNTAX = /^[\x21-\x7e]+$/;

export type ValueSchema = {
  description?: string;
  type?: (typeof TYPES)[number];
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, ValueSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ValueSchema;
  minItems?: number;
  maxItems?: number;
};

type KeyRule = {
  template: string;
  matcher: RegExp;
  placeholders: string[];
  params: Record<string, ValueSchema>;
  value: ValueSchema | null;
};

export type EntrySchema = { rules: KeyRule[] };

export class EntrySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntrySchemaError";
  }
}

/**
 * The text of the schema block, or null when the document declares none.
 * Throws EntrySchemaError when it declares more than one.
 */
export function extractEntrySchema(html: string): string | null {
  const found: string[] = [];
  const stack: Node[] = [parse(html)];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeName === "script" && "attrs" in node) {
      const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
      if (
        attrs.get("id") === ENTRY_SCHEMA_ELEMENT_ID &&
        attrs.get("type")?.toLowerCase() === "application/json"
      ) {
        found.push(node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""));
      }
    }
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  if (found.length > 1) {
    throw new EntrySchemaError(`The page declares ${found.length} entry schemas. Keep one.`);
  }
  return found[0] ?? null;
}

/** Parses and checks a schema. Throws EntrySchemaError saying what to fix. */
export function parseEntrySchema(text: string): EntrySchema {
  if (Buffer.byteLength(text) > ENTRY_SCHEMA_MAX_BYTES) {
    throw new EntrySchemaError(`The entry schema is larger than ${ENTRY_SCHEMA_MAX_BYTES} bytes.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EntrySchemaError("The entry schema is not valid JSON.");
  }
  if (!isRecord(raw) || !isRecord(raw.keys)) {
    throw new EntrySchemaError('The entry schema is an object with a "keys" object.');
  }
  const extra = Object.keys(raw).filter((name) => name !== "keys");
  if (extra.length > 0) {
    throw new EntrySchemaError(`The entry schema has an unknown field: ${extra[0]}.`);
  }
  const templates = Object.keys(raw.keys);
  if (templates.length > MAX_KEY_RULES) {
    throw new EntrySchemaError(`The entry schema declares more than ${MAX_KEY_RULES} keys.`);
  }
  return {
    rules: templates.map((template) =>
      keyRule(template, (raw.keys as Record<string, unknown>)[template]),
    ),
  };
}

function keyRule(template: string, definition: unknown): KeyRule {
  const where = `keys["${template}"]`;
  if (
    template.length > ENTRY_KEY_MAX_LENGTH ||
    !KEY_SYNTAX.test(template.replace(/\{[^}]*\}/g, "x"))
  ) {
    throw new EntrySchemaError(
      `${where}: a key is at most ${ENTRY_KEY_MAX_LENGTH} printable characters with no spaces.`,
    );
  }
  const parts = template.split(/(\{[^}]*\})/).filter((part) => part !== "");
  const placeholders: string[] = [];
  let source = "^";
  let previousWasPlaceholder = false;
  for (const part of parts) {
    const name = /^\{(.*)\}$/.exec(part)?.[1];
    if (name === undefined) {
      if (/[{}]/.test(part)) throw new EntrySchemaError(`${where}: unbalanced braces.`);
      source += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      previousWasPlaceholder = false;
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new EntrySchemaError(`${where}: "${name}" is not a valid placeholder name.`);
    }
    if (placeholders.includes(name)) {
      throw new EntrySchemaError(`${where}: the placeholder {${name}} appears twice.`);
    }
    if (previousWasPlaceholder) {
      throw new EntrySchemaError(`${where}: two placeholders need text between them.`);
    }
    placeholders.push(name);
    source += "([^:]+)";
    previousWasPlaceholder = true;
  }
  if (placeholders.length > MAX_PLACEHOLDERS) {
    throw new EntrySchemaError(`${where}: at most ${MAX_PLACEHOLDERS} placeholders.`);
  }

  if (!isRecord(definition)) throw new EntrySchemaError(`${where} is an object.`);
  for (const field of Object.keys(definition)) {
    if (!["description", "params", "value"].includes(field)) {
      throw new EntrySchemaError(`${where}: unknown field "${field}".`);
    }
  }
  if (definition.description !== undefined && typeof definition.description !== "string") {
    throw new EntrySchemaError(`${where}.description is a string.`);
  }
  const params: Record<string, ValueSchema> = {};
  if (definition.params !== undefined) {
    if (!isRecord(definition.params)) throw new EntrySchemaError(`${where}.params is an object.`);
    for (const [name, schema] of Object.entries(definition.params)) {
      if (!placeholders.includes(name)) {
        throw new EntrySchemaError(`${where}.params.${name} names no placeholder in the key.`);
      }
      params[name] = valueSchema(schema, `${where}.params.${name}`, 0);
    }
  }
  const value =
    definition.value === undefined ? null : valueSchema(definition.value, `${where}.value`, 0);
  return { template, matcher: new RegExp(`${source}$`), placeholders, params, value };
}

function valueSchema(schema: unknown, where: string, depth: number): ValueSchema {
  if (depth > MAX_DEPTH) throw new EntrySchemaError(`${where}: nested too deeply.`);
  if (!isRecord(schema)) throw new EntrySchemaError(`${where} is an object.`);
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword)) {
      throw new EntrySchemaError(
        `${where}: "${keyword}" is not supported. Supported: ${[...KEYWORDS].join(", ")}.`,
      );
    }
  }
  const out: ValueSchema = {};
  if (schema.description !== undefined) {
    if (typeof schema.description !== "string") {
      throw new EntrySchemaError(`${where}.description is a string.`);
    }
    out.description = schema.description;
  }
  if (schema.type !== undefined) {
    if (!TYPES.includes(schema.type as (typeof TYPES)[number])) {
      throw new EntrySchemaError(`${where}.type is one of ${TYPES.join(", ")}.`);
    }
    out.type = schema.type as (typeof TYPES)[number];
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new EntrySchemaError(`${where}.enum is a non-empty array.`);
    }
    out.enum = schema.enum;
  }
  if ("const" in schema) out.const = schema.const;
  for (const bound of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
  ] as const) {
    const limit = schema[bound];
    if (limit === undefined) continue;
    const integer = bound !== "minimum" && bound !== "maximum";
    if (
      typeof limit !== "number" ||
      !Number.isFinite(limit) ||
      (integer && !(Number.isInteger(limit) && limit >= 0))
    ) {
      throw new EntrySchemaError(
        `${where}.${bound} is ${integer ? "a non-negative integer" : "a number"}.`,
      );
    }
    out[bound] = limit;
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties))
      throw new EntrySchemaError(`${where}.properties is an object.`);
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        valueSchema(property, `${where}.properties.${name}`, depth + 1),
      ]),
    );
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      !schema.required.every((name) => typeof name === "string")
    ) {
      throw new EntrySchemaError(`${where}.required is an array of names.`);
    }
    out.required = schema.required;
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties !== "boolean") {
      throw new EntrySchemaError(`${where}.additionalProperties is true or false.`);
    }
    out.additionalProperties = schema.additionalProperties;
  }
  if (schema.items !== undefined)
    out.items = valueSchema(schema.items, `${where}.items`, depth + 1);
  return out;
}

/** What is wrong with an entry under the schema, or null when it fits. */
export function checkEntry(schema: EntrySchema, key: string, value: unknown): string | null {
  for (const rule of schema.rules) {
    const match = rule.matcher.exec(key);
    if (!match) continue;
    for (const [index, name] of rule.placeholders.entries()) {
      const param = rule.params[name];
      const problem = param ? checkValue(match[index + 1], param, `{${name}}`) : null;
      if (problem) return `${key}: ${problem}`;
    }
    return rule.value ? checkValue(value, rule.value, "value") : null;
  }
  const declared = schema.rules.map((rule) => rule.template).join(", ");
  return `${key} matches no key this artifact declares (${declared}).`;
}

function checkValue(value: unknown, schema: ValueSchema, where: string): string | null {
  if (schema.type !== undefined && !hasType(value, schema.type)) {
    return `${where} must be ${article(schema.type)}.`;
  }
  if ("const" in schema && !sameValue(value, schema.const)) {
    return `${where} must be ${JSON.stringify(schema.const)}.`;
  }
  if (schema.enum && !schema.enum.some((option) => sameValue(value, option))) {
    return `${where} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}.`;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${where} must be at least ${schema.minLength} characters.`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${where} must be at most ${schema.maxLength} characters.`;
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${where} must be at least ${schema.minimum}.`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${where} must be at most ${schema.maximum}.`;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${where} must have at least ${schema.minItems} items.`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${where} must have at most ${schema.maxItems} items.`;
    }
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        const problem = checkValue(item, schema.items, `${where}[${index}]`);
        if (problem) return problem;
      }
    }
  }
  if (isRecord(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) return `${where}.${name} is required.`;
    }
    for (const [name, property] of Object.entries(value)) {
      const rule =
        schema.properties && Object.hasOwn(schema.properties, name)
          ? schema.properties[name]
          : undefined;
      if (rule) {
        const problem = checkValue(property, rule, `${where}.${name}`);
        if (problem) return problem;
      } else if (schema.additionalProperties === false) {
        return `${where}.${name} is not allowed.`;
      }
    }
  }
  return null;
}

function hasType(value: unknown, type: ValueSchema["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function article(type: string): string {
  return type === "null" ? "null" : `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && sameValue(a[key], b[key]))
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a key is well formed, before any schema is consulted. */
export function isEntryKey(key: string): boolean {
  return key.length > 0 && key.length <= ENTRY_KEY_MAX_LENGTH && KEY_SYNTAX.test(key);
}

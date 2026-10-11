/** A run of text, marked when it is part of a word the query matched. */
export type TextSegment = { text: string; match?: true };

/** Lowercased, without diacritics, with the original index of each character. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  let index = 0;
  for (const character of text) {
    const plain = character.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let i = 0; i < plain.length; i += 1) origin.push(index);
    folded += plain;
    index += character.length;
  }
  return { folded, origin };
}

/**
 * Where the words occur in `text`, as [start, end) offsets. A word matches the
 * start of a longer one, as the prefix index does. Other forms of a word
 * ("tried" for "tries") come from the porter index instead.
 */
function findMatches(text: string, words: string[]): [number, number][] {
  if (words.length === 0) return [];
  const { folded, origin } = fold(text);
  const alternatives = words.map((word) => fold(word.normalize("NFKC")).folded).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})[\\p{L}\\p{N}]*`, "gu");
  const found: [number, number][] = [];
  for (const match of folded.matchAll(pattern)) {
    const end = match.index + match[0].length;
    found.push([
      origin[match.index] ?? 0,
      end < origin.length ? (origin[end] ?? text.length) : text.length,
    ]);
  }
  return found;
}

function segments(text: string, matches: [number, number][], from: number, to: number) {
  const result: TextSegment[] = [];
  let at = from;
  for (const [start, end] of matches) {
    if (end <= from || start >= to) continue;
    if (start > at) result.push({ text: text.slice(at, start) });
    result.push({ text: text.slice(Math.max(start, from), Math.min(end, to)), match: true });
    at = Math.min(end, to);
  }
  if (at < to) result.push({ text: text.slice(at, to) });
  return result.map((segment) => ({ ...segment, text: segment.text.replace(/\s+/g, " ") }));
}

/** The prefix matches and the porter index's matches, in order and without overlaps. */
function allMatches(text: string, words: string[], stemmed: [number, number][]) {
  const sorted = [...findMatches(text, words), ...stemmed].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** All of `text`, with the matched words marked. */
export function highlight(
  text: string,
  words: string[],
  stemmed: [number, number][] = [],
): TextSegment[] {
  return segments(text, allMatches(text, words, stemmed), 0, text.length);
}

/**
 * A short passage around the first match, and how many matches the text has.
 * With no match, the passage is the start of the text.
 */
export function snippet(
  text: string,
  words: string[],
  stemmed: [number, number][] = [],
  length = 180,
): { snippet: TextSegment[]; matches: number } {
  const matches = allMatches(text, words, stemmed);
  const first = matches[0];
  let from = first ? Math.max(0, first[0] - Math.floor(length / 3)) : 0;
  let to = Math.min(text.length, from + length);
  // Start and end on word boundaries. Blocks are separated by newlines.
  if (from > 0) {
    const space = text.slice(from).search(/\s/);
    if (space !== -1 && first && from + space < first[0]) from += space + 1;
  }
  if (to < text.length) {
    const space = text.slice(0, to + 1).search(/\s\S*$/);
    if (space > (first?.[1] ?? from)) to = space;
  }
  const passage = segments(text, matches, from, to);
  if (from > 0) passage.unshift({ text: "…" });
  if (to < text.length) passage.push({ text: "…" });
  return { snippet: passage, matches: matches.length };
}

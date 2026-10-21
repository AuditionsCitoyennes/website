/*
 * Auditions Citoyennes — data ingestion pipeline
 * Copyright (C) 2026 Auditions Citoyennes
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed WITHOUT ANY WARRANTY;
 * see the GNU Affero General Public License for more details:
 * <https://www.gnu.org/licenses/>.
 */

/**
 * Tolerant parser for the GDN JSON exports: a JSON array laid out (mostly)
 * one object per line, with at least one malformed line in the wild. A naive
 * JSON.parse of the whole file fails, so we stream line by line, accumulate
 * until braces balance, parse each object independently, and report failures
 * instead of aborting.
 */

export interface ParseFailure {
  startLine: number;
  endLine: number;
  snippet: string;
  error: string;
}

export interface ParsedObject<T = unknown> {
  value: T;
  startLine: number;
  endLine: number;
}

/** Depth of {} and [] nesting at the end of `text`, ignoring string contents. */
function scanDepth(text: string, initial = 0): number {
  let depth = initial;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth;
}

/**
 * Strips the array framing so a chunk can be parsed as a standalone object:
 * leading "[" / "," and trailing "," / final "]".
 */
function stripFraming(chunk: string): string {
  let s = chunk.trim();
  while (s.startsWith("[") || s.startsWith(",")) s = s.slice(1).trimStart();
  while (s.endsWith(",")) s = s.slice(0, -1).trimEnd();
  // A trailing "]" is array framing only if the remainder is itself balanced
  // (e.g. the last line of the file is "}]").
  if (s.endsWith("]") && scanDepth(s.slice(0, -1)) === 0) s = s.slice(0, -1).trimEnd();
  return s;
}

const MAX_BUFFERED_LINES = 200;

export async function* parseJsonObjectStream<T = unknown>(
  lines: AsyncIterable<string> | Iterable<string>,
  onFailure?: (failure: ParseFailure) => void,
): AsyncGenerator<ParsedObject<T>> {
  let pending: { text: string; line: number }[] = [];

  const fail = (error: string) => {
    const first = pending[0];
    onFailure?.({
      startLine: first.line,
      endLine: pending[pending.length - 1].line,
      snippet: first.text.slice(0, 200),
      error,
    });
    // Drop the first buffered line and retry from the next: a single bad line
    // (unbalanced quote, truncated object) must not swallow the rest of the file.
    pending = pending.slice(1);
  };

  function* drain(atEof: boolean): Generator<ParsedObject<T>> {
    outer: for (;;) {
      // Skip non-object noise ("[", "]", empty separators).
      while (pending.length > 0 && stripFraming(pending[0].text) === "") pending.shift();
      if (pending.length === 0) return;

      // Parse the SHORTEST balanced prefix of buffered lines, not the whole
      // buffer: after a malformed line is dropped, the remainder may hold
      // several complete objects and must not be swallowed as one chunk.
      let text = "";
      for (let i = 0; i < pending.length; i++) {
        text = i === 0 ? pending[0].text : `${text}\n${pending[i].text}`;
        const candidate = stripFraming(text);
        if (candidate === "" || scanDepth(candidate) !== 0) continue;
        try {
          const value = JSON.parse(candidate) as T;
          yield { value, startLine: pending[0].line, endLine: pending[i].line };
          pending = pending.slice(i + 1);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        continue outer;
      }
      if (atEof) {
        fail("unterminated JSON object at end of file");
        continue;
      }
      if (pending.length > MAX_BUFFERED_LINES) {
        fail(`no balanced JSON object within ${MAX_BUFFERED_LINES} lines`);
        continue;
      }
      return; // unbalanced: wait for more lines
    }
  }

  let lineNo = 0;
  for await (const raw of lines) {
    lineNo++;
    pending.push({ text: raw, line: lineNo });
    yield* drain(false);
  }
  yield* drain(true);
}

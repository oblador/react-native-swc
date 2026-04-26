/**
 * Source-map plumbing between SWC's standard v3 output and Metro's raw
 * segment-tuple format.
 *
 * Metro tuples:
 *   [genLine, genCol]                            — generated position only
 *   [genLine, genCol, origLine, origCol]         — generated + original
 *   [genLine, genCol, origLine, origCol, name]   — + symbol name
 *
 * `genLine` is 1-based (Metro convention). Columns are 0-based.
 */
import { decode } from '@jridgewell/sourcemap-codec';

import type { MetroSourceMapSegmentTuple } from './types';

const NEWLINE_RE = /\r\n?|\n|\u2028|\u2029/g;

/**
 * Decode a raw sourcemap emitted by SWC into Metro's flat tuple array.
 * Accepts either a JSON string or a parsed object; returns `[]` on any
 * shape we don't recognize so callers can plumb through cleanly.
 */
export function decodeRawSourceMap(rawMap: unknown): MetroSourceMapSegmentTuple[] {
  if (!rawMap) return [];
  const parsed = parseSourceMap(rawMap);
  if (!parsed) return [];
  const { mappings, names } = parsed;
  return flattenSegments(decode(mappings), names);
}

interface ParsedV3 {
  mappings: string;
  names: string[];
}

function parseSourceMap(raw: unknown): ParsedV3 | null {
  try {
    const obj =
      typeof raw === 'string'
        ? (JSON.parse(raw) as { mappings?: unknown; names?: unknown })
        : (raw as { mappings?: unknown; names?: unknown });
    if (typeof obj.mappings !== 'string') return null;
    const names = Array.isArray(obj.names)
      ? obj.names.filter((n): n is string => typeof n === 'string')
      : [];
    return { mappings: obj.mappings, names };
  } catch {
    return null;
  }
}

/**
 * Turn jridgewell's per-line segment arrays into Metro's flat 1-based tuples.
 * jridgewell emits absolute (already-accumulated) values, so no VLQ or
 * delta accounting is needed here.
 */
type RawSegment =
  | [number]
  | [number, number, number, number]
  | [number, number, number, number, number];

function flattenSegments(
  linesSegments: ReadonlyArray<ReadonlyArray<RawSegment>>,
  names: ReadonlyArray<string>,
): MetroSourceMapSegmentTuple[] {
  const out: MetroSourceMapSegmentTuple[] = [];
  for (let i = 0; i < linesSegments.length; i++) {
    const genLine = i + 1;
    for (const seg of linesSegments[i]) {
      if (seg.length === 1) {
        out.push([genLine, seg[0]]);
        continue;
      }
      // seg = [genCol, sourceIndex, origLine, origCol, nameIndex?]
      const [genCol, , origLine0, origCol] = seg;
      const origLine = origLine0 + 1;
      if (seg.length === 5) {
        const name = names[seg[4]];
        out.push(
          typeof name === 'string'
            ? [genLine, genCol, origLine, origCol, name]
            : [genLine, genCol, origLine, origCol],
        );
      } else {
        out.push([genLine, genCol, origLine, origCol]);
      }
    }
  }
  return out;
}

/**
 * Shift every generated line number by `lineOffset`. Used after prepending
 * a wrapper (e.g. `__d(function(…) {` introduces one line) so the tuples
 * still line up with the final code.
 */
export function shiftGeneratedLines(
  map: ReadonlyArray<MetroSourceMapSegmentTuple>,
  lineOffset: number,
): MetroSourceMapSegmentTuple[] {
  if (lineOffset === 0) return [...map];
  return map.map((seg) => {
    if (seg.length === 5) {
      return [seg[0] + lineOffset, seg[1], seg[2], seg[3], seg[4]];
    }
    if (seg.length === 4) {
      return [seg[0] + lineOffset, seg[1], seg[2], seg[3]];
    }
    return [seg[0] + lineOffset, seg[1]];
  });
}

/** Count `\r\n` / `\n` / `\u2028` / `\u2029` line terminators in `text`. */
export function countNewlines(text: string): number {
  const m = text.match(NEWLINE_RE);
  return m ? m.length : 0;
}

/**
 * Return `lineCount` and a copy of `map` with a terminating segment appended
 * (Metro expects the final generated position as the last tuple).
 */
export function countLinesAndTerminateMap(
  code: string,
  map: ReadonlyArray<MetroSourceMapSegmentTuple>,
): { lineCount: number; map: MetroSourceMapSegmentTuple[] } {
  let lineCount = 1;
  let lastLineStart = 0;
  for (const match of code.matchAll(NEWLINE_RE)) {
    lineCount++;
    lastLineStart = match.index! + match[0].length;
  }
  const terminator: MetroSourceMapSegmentTuple = [lineCount, code.length - lastLineStart];
  const last = map[map.length - 1];
  if (!last || last[0] !== terminator[0] || last[1] !== terminator[1]) {
    return { lineCount, map: [...map, terminator] };
  }
  return { lineCount, map: [...map] };
}

/**
 * Compose two source maps: `outerMap` references original positions that
 * live inside `innerMap`. Produces a new map whose generated positions are
 * `outerMap`'s and whose original positions trace through `innerMap` to the
 * true source. Used to fold a pre-minify → original map into a
 * minified → original map after we post-minify with SWC.
 */
export function composeSourceMaps(
  outerMap: ReadonlyArray<MetroSourceMapSegmentTuple>,
  innerMap: ReadonlyArray<MetroSourceMapSegmentTuple>,
): MetroSourceMapSegmentTuple[] {
  if (outerMap.length === 0) return [];
  if (innerMap.length === 0) return [...outerMap];

  const innerByLine = groupInnerByLine(innerMap);

  return outerMap.map((seg): MetroSourceMapSegmentTuple => {
    if (seg.length === 2) return [seg[0], seg[1]];

    const [genLine, genCol, outerOrigLine, outerOrigCol] = seg;
    const candidates = innerByLine.get(outerOrigLine);
    if (!candidates || candidates.length === 0) return [genLine, genCol];

    const chosen = pickInnerSegment(candidates, outerOrigCol);
    if (!chosen || chosen.length === 2) return [genLine, genCol];

    const colDelta = Math.max(0, outerOrigCol - chosen[1]);
    const composedLine = chosen[2];
    const composedCol = Math.max(0, chosen[3] + colDelta);

    if (chosen.length === 5) {
      return [genLine, genCol, composedLine, composedCol, chosen[4]];
    }
    return [genLine, genCol, composedLine, composedCol];
  });
}

function groupInnerByLine(
  innerMap: ReadonlyArray<MetroSourceMapSegmentTuple>,
): Map<number, MetroSourceMapSegmentTuple[]> {
  const byLine = new Map<number, MetroSourceMapSegmentTuple[]>();
  for (const seg of innerMap) {
    if (seg.length < 4) continue;
    const arr = byLine.get(seg[0]);
    if (arr) arr.push(seg);
    else byLine.set(seg[0], [seg]);
  }
  for (const arr of byLine.values()) arr.sort((a, b) => a[1] - b[1]);
  return byLine;
}

/**
 * Pick the segment whose generated column is the closest one to the
 * left of `targetCol`. Segments are pre-sorted by column.
 */
function pickInnerSegment(
  sortedByColumn: ReadonlyArray<MetroSourceMapSegmentTuple>,
  targetCol: number,
): MetroSourceMapSegmentTuple | undefined {
  let chosen = sortedByColumn[0];
  for (const candidate of sortedByColumn) {
    if (candidate[1] <= targetCol) chosen = candidate;
    else break;
  }
  return chosen;
}

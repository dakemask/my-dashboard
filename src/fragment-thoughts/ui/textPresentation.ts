import type { HighlightRange } from "./types";

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function appendHighlightedRanges(
  parent: HTMLElement,
  text: string,
  ranges: readonly HighlightRange[],
): boolean {
  parent.replaceChildren();
  let cursor = 0;
  let highlighted = false;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.end)
      || range.start < cursor
      || range.end <= range.start
      || range.end > text.length
    ) {
      continue;
    }
    parent.append(text.slice(cursor, range.start));
    const mark = parent.ownerDocument.createElement("mark");
    mark.textContent = text.slice(range.start, range.end);
    parent.append(mark);
    cursor = range.end;
    highlighted = true;
  }
  parent.append(text.slice(cursor));
  return highlighted;
}

/** Compatibility only; new callers pass ranges from the presentation layer. */
export function findLegacyHighlightRanges(
  text: string,
  query: string,
): readonly HighlightRange[] {
  if (query.length === 0) return [];
  const matcher = new RegExp(escapeRegExp(query), "giu");
  const ranges: HighlightRange[] = [];
  for (const match of text.matchAll(matcher)) {
    if (match.index === undefined || match[0].length === 0) continue;
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return ranges;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

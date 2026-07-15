export const MAX_TRANSCRIPT_MARKERS = 400;

export type TranscriptEntryKind = "user" | "assistant" | "thinking" | "tool" | "error";
export type TranscriptMinimapMode = "user" | "messages" | "events";

/** Select the semantic entries represented by the chosen minimap mode. */
export function filterTranscriptEntryIndices(
  kinds: readonly TranscriptEntryKind[],
  mode: TranscriptMinimapMode,
): number[] {
  return kinds.flatMap((kind, index) => {
    if (mode === "events") return [index];
    if (mode === "messages") return kind === "user" || kind === "assistant" ? [index] : [];
    return kind === "user" ? [index] : [];
  });
}

/** Produce one short, plain-text line for a minimap hover card. */
export function compactTranscriptPreview(text: string, maxLength = 180): string {
  const compact = text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/[`*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= maxLength) return compact;
  return compact.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

/** Find the rendered transcript entry nearest the viewport's reading line. */
export function findNearestTranscriptEntry(offsets: number[], focusY: number): number {
  if (!offsets.length) return -1;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= focusY) low = mid;
    else high = mid - 1;
  }
  if (low === offsets.length - 1) return low;
  return focusY - offsets[low] <= offsets[low + 1] - focusY ? low : low + 1;
}

/** Keep the minimap bounded for very long Claude Code sessions. */
export function sampleTranscriptEntries(total: number, limit = MAX_TRANSCRIPT_MARKERS): number[] {
  if (total <= 0 || limit <= 0) return [];
  if (total <= limit) return Array.from({ length: total }, (_, index) => index);
  if (limit === 1) return [0];
  return Array.from({ length: limit }, (_, index) =>
    Math.round((index * (total - 1)) / (limit - 1)),
  );
}

/** Convert a content offset into a clamped 0..1 minimap-track position. */
export function transcriptMarkerRatio(offset: number, contentHeight: number): number {
  if (contentHeight <= 0) return 0;
  return Math.min(1, Math.max(0, offset / contentHeight));
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  compactTranscriptPreview,
  filterTranscriptBlockIndices,
  filterTranscriptEntryIndices,
  findNearestTranscriptEntry,
  sampleTranscriptEntries,
  transcriptMarkerRatio,
} from "../src/transcript-nav.ts";

test("Focused transcript keeps design context and error tool pairs", () => {
  const blocks = [
    { kind: "text", context_relevant: true },
    { kind: "text", context_relevant: false },
    { kind: "thinking", context_relevant: false },
    { kind: "tool_use", context_relevant: false },
    { kind: "tool_result", context_relevant: false, is_error: false },
    { kind: "tool_use", context_relevant: false },
    { kind: "tool_result", context_relevant: true, is_error: true },
    { kind: "text", context_relevant: true },
  ] as const;

  assert.deepEqual(filterTranscriptBlockIndices(blocks, "focused"), [0, 5, 6, 7]);
  assert.deepEqual(filterTranscriptBlockIndices(blocks, "all"), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("filterTranscriptEntryIndices applies the three minimap detail modes", () => {
  const kinds = ["user", "assistant", "thinking", "tool", "error"] as const;

  assert.deepEqual(filterTranscriptEntryIndices(kinds, "user"), [0]);
  assert.deepEqual(filterTranscriptEntryIndices(kinds, "messages"), [0, 1]);
  assert.deepEqual(filterTranscriptEntryIndices(kinds, "events"), [0, 1, 2, 3, 4]);
});

test("compactTranscriptPreview makes long transcript blocks scannable", () => {
  const source = "# Tool call\n\n  npm   run   build\n" + "result ".repeat(40);

  const preview = compactTranscriptPreview(source, 54);

  assert.equal(preview, "Tool call npm run build result result result result r…");
  assert.equal(preview.length, 54);
});

test("findNearestTranscriptEntry returns the block nearest the reading focus", () => {
  const offsets = [20, 180, 510, 900];

  assert.equal(findNearestTranscriptEntry(offsets, 15), 0);
  assert.equal(findNearestTranscriptEntry(offsets, 340), 1);
  assert.equal(findNearestTranscriptEntry(offsets, 760), 3);
});

test("sampleTranscriptEntries preserves endpoints while limiting long sessions", () => {
  const sampled = sampleTranscriptEntries(2_000, 400);

  assert.equal(sampled.length, 400);
  assert.equal(sampled[0], 0);
  assert.equal(sampled.at(-1), 1_999);
  assert.ok(sampled.every((value, index) => index === 0 || value > sampled[index - 1]));
});

test("transcriptMarkerRatio clamps positions to the minimap track", () => {
  assert.equal(transcriptMarkerRatio(-10, 1_000), 0);
  assert.equal(transcriptMarkerRatio(250, 1_000), 0.25);
  assert.equal(transcriptMarkerRatio(2_000, 1_000), 1);
});

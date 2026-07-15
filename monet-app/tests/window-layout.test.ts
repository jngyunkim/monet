import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const capability = JSON.parse(
  readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as { permissions: string[] };
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("both top headers drag from non-interactive descendants", () => {
  assert.match(html, /class="sidebar-header" data-tauri-drag-region="deep"/);
  assert.match(html, /class="viewer-header" data-tauri-drag-region="deep"/);
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
});

test("transcript minimap is pinned to the main area's left edge", () => {
  const rule = styles.match(/\.transcript-map\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(rule, /left:\s*12px;/);
  assert.doesNotMatch(rule, /calc\(/);
});

test("settings exposes the three exclusive transcript minimap modes", () => {
  assert.match(html, /id="minimap-mode-select" role="radiogroup"/);
  assert.match(html, /data-minimap-mode="user"/);
  assert.match(html, /data-minimap-mode="messages"/);
  assert.match(html, /data-minimap-mode="events"/);
});

test("Explore in depth renders as a single scannable list", () => {
  assert.match(main, /className = "tree-list"/);
  assert.match(main, /class="tree-row-end"/);
  const rule = styles.match(/\.tree-list\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /display:\s*flex;/);
  assert.match(rule, /flex-direction:\s*column;/);
});

test("Design section titles share the UI font family", () => {
  assert.match(styles, /--ui-font:/);
  const rule = styles.match(/\.level-content-title\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /font-family:\s*var\(--ui-font\);/);
});

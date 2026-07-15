import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import mermaid from "mermaid";
import { marked } from "marked";
import {
  compactTranscriptPreview,
  filterTranscriptBlockIndices,
  filterTranscriptEntryIndices,
  findNearestTranscriptEntry,
  sampleTranscriptEntries,
  transcriptMarkerRatio,
  type TranscriptEntryKind,
  type TranscriptFilterMode,
  type TranscriptMinimapMode,
} from "./transcript-nav";
import { microworldStateRows } from "./microworld";

mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "loose" });

type SessionMeta = {
  id: string;
  path: string;
  project: string;
  title: string;
  modified: number;
  message_count: number;
};

type Diagram = {
  title: string;
  kind: string; // "mermaid" | "mingrammer"
  source: string;
  explanation: string;
  level: string;
  rendered: string;
  unavailable: string | null;
};

type Term = { term: string; definition: string; category: string };

/** A selectable component/topic to drill into. */
type TreeRef = { id: string; name: string; blurb: string };
type MicroworldRef = { id: string; title: string; blurb: string };
/** The forest: big-picture overview + the trees to explore. */
type Forest = {
  overview: string;
  diagrams: Diagram[];
  terms: Term[];
  trees: TreeRef[];
};
/** One explored tree: an in-depth look at a single component/topic. */
type Tree = {
  name: string;
  content: string;
  diagrams: Diagram[];
  terms: Term[];
  microworlds?: MicroworldRef[];
};
type MicroworldStep = {
  label: string;
  detail: string;
  from: string;
  to: string;
  state: Record<string, string>;
};
type Microworld = {
  kind: "steps";
  title: string;
  intro: string;
  actors: string[];
  steps: MicroworldStep[];
};

type AskTurn = { role: "user" | "assistant"; content: string };

/** Reflect section: active recall by reconstruction (teach_back) and recall in
 *  service of participation (propose_next). Threads are kept per tree. */
type ReflectMode = "teach_back" | "propose_next";
type ReflectThreads = { teach_back: AskTurn[]; propose_next: AskTurn[] };

/** One structured transcript block (session Transcript tab). */
type Msg = {
  role: "user" | "assistant";
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  tool?: string;
  subtitle?: string;
  is_error: boolean;
  context_relevant: boolean;
};

type DepStatus = {
  claude: boolean;
  python: boolean;
  graphviz: boolean;
  diagrams_pkg: boolean;
};

let sessions: SessionMeta[] = [];
let selected: SessionMeta | null = null;
let sourceTab: "sessions" | "links" = "sessions";
// Multi-select for bulk delete: mode flag, the chosen paths, and whether the
// bulk-delete confirmation is showing.
let selectMode = false;
const selectedForDelete = new Set<string>();
let confirmingBulk = false;
const isLinkSource = (s: SessionMeta) => s.path.endsWith(".links.json");
type View = "design" | "ask" | "transcript";
let currentView: View = "design";

// Design = forest (overview + tree list) → drill into one tree at a time.
let forest: Forest | null = null;
let treeCache: Record<string, Tree | null> = {}; // by tree id
let currentTreeId: string | null = null; // null = forest view; else drilled into a tree
let microworldCache: Record<string, Microworld | null> = {};
let activeMicroworld: Record<string, string | null> = {};
let microworldStep: Record<string, number> = {};
// What's generating right now (so the panel can show a loading + Stop).
let busy:
  | { kind: "forest" }
  | { kind: "tree"; id: string }
  | { kind: "microworld"; treeId: string; worldId: string }
  | null = null;

// Ask tab conversation for the selected source.
let askHistory: AskTurn[] = [];
let asking = false;

// Reflect threads per tree id, and the single in-flight reflection (if any).
let reflectState: Record<string, ReflectThreads> = {};
let reflecting: { treeId: string; mode: ReflectMode } | null = null;

type Lang = "en" | "ko";
const savedLang = localStorage.getItem("bp-lang");
let lang: Lang = savedLang === "ko" ? "ko" : "en";

const savedMinimapMode = localStorage.getItem("bp-minimap-mode");
let minimapMode: TranscriptMinimapMode =
  savedMinimapMode === "user" ||
  savedMinimapMode === "messages" ||
  savedMinimapMode === "events"
    ? savedMinimapMode
    : "events";

const savedTranscriptFilter = localStorage.getItem("monet-transcript-filter");
let transcriptFilterMode: TranscriptFilterMode =
  savedTranscriptFilter === "all" ? "all" : "focused";

type Model = "haiku" | "sonnet" | "opus";
const MODEL_LABELS: Record<Model, string> = {
  haiku: "Haiku 4.5",
  sonnet: "Sonnet 5",
  opus: "Opus 4.8",
};
const savedModel = localStorage.getItem("bp-model");
let model: Model =
  savedModel === "haiku" || savedModel === "sonnet" || savedModel === "opus"
    ? savedModel
    : "sonnet";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const sessionList = $("#session-list");
const filterInput = $<HTMLInputElement>("#filter-input");
const emptyState = $("#empty-state");
const viewer = $("#viewer");
const viewerTitle = $("#viewer-title");
const viewerSub = $("#viewer-sub");
const statusBar = $("#status-bar");
const designView = $("#design-view");
const askView = $("#ask-view");
const transcriptShell = $("#transcript-shell");
const transcriptView = $<HTMLDivElement>("#transcript-view");
const transcriptFilterBar = $("#transcript-filter-bar");
const transcriptMap = $("#transcript-map");
const transcriptMapTrack = $("#transcript-map-track");
const transcriptMapPreview = $("#transcript-map-preview");

type TranscriptNavKind = TranscriptEntryKind;
type TranscriptNavEntry = {
  element: HTMLElement;
  label: string;
  preview: string;
  kind: TranscriptNavKind;
};
let transcriptNavEntries: TranscriptNavEntry[] = [];
let transcriptModeEntryIndices: number[] = [];
let transcriptNavMarkers: HTMLButtonElement[] = [];
let transcriptNavFrame = 0;
let transcriptProgressFrame = 0;
let transcriptHoverMarker = -1;
let transcriptBlocks: Msg[] = [];

function fmtDate(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderSessionList() {
  const q = filterInput.value.trim().toLowerCase();
  const filtered = sessions.filter((s) => {
    if (sourceTab === "links" ? !isLinkSource(s) : isLinkSource(s)) return false;
    return (
      !q ||
      s.title.toLowerCase().includes(q) ||
      s.project.toLowerCase().includes(q)
    );
  });

  sessionList.innerHTML = "";

  // Header row: the "Recents"/"Links" label plus the select-mode actions.
  const header = document.createElement("div");
  header.className = "recents-header";
  const label = document.createElement("span");
  label.className = "recents-label";
  label.textContent = sourceTab === "links" ? "Links" : "Recents";
  header.appendChild(label);
  if (filtered.length > 0) header.appendChild(selectActions(filtered));
  sessionList.appendChild(header);

  if (confirmingBulk) {
    const bar = document.createElement("div");
    bar.className = "bulk-confirm";
    bar.innerHTML = `
      <span class="confirm-text">Move ${selectedForDelete.size} to Trash?</span>
      <span class="confirm-actions">
        <button class="confirm-yes">Trash</button>
        <button class="confirm-no">Cancel</button>
      </span>`;
    bar.querySelector(".confirm-no")!.addEventListener("click", () => {
      confirmingBulk = false;
      renderSessionList();
    });
    bar.querySelector(".confirm-yes")!.addEventListener("click", () =>
      bulkDelete([...selectedForDelete]),
    );
    sessionList.appendChild(bar);
  }

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      sourceTab === "links" ? "No imported links yet." : "No sessions found.";
    sessionList.appendChild(empty);
    return;
  }

  // Flat, Claude-style list: title only, active row gets a dot + highlight.
  for (const s of filtered) {
    const checked = selectedForDelete.has(s.path);
    const item = document.createElement("div");
    item.className =
      "session-item" +
      (!selectMode && selected?.path === s.path ? " active" : "") +
      (selectMode ? " selecting" : "") +
      (selectMode && checked ? " checked" : "");

    const open = document.createElement("button");
    open.className = "session-open";
    open.title = `${s.project} · ${fmtDate(s.modified)} · ${s.message_count} msgs`;
    const marker = selectMode
      ? `<span class="session-check">${checked ? "✓" : ""}</span>`
      : `<span class="session-dot"></span>`;
    open.innerHTML = `${marker}<span class="session-title">${escapeHtml(s.title)}</span>`;
    open.addEventListener("click", () => {
      if (selectMode) toggleForDelete(s);
      else selectSession(s);
    });
    item.appendChild(open);

    if (!selectMode) {
      const del = document.createElement("button");
      del.className = "session-del";
      del.title = "Move to Trash";
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDelete(item, s);
      });
      item.appendChild(del);
    }

    sessionList.appendChild(item);
  }
}

/** The right-side header actions: "Select" normally, or "Delete (N) / Cancel"
 *  while in select mode. */
function selectActions(filtered: SessionMeta[]): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "list-actions";
  if (!selectMode) {
    const start = document.createElement("button");
    start.className = "list-action";
    start.textContent = "Select";
    start.addEventListener("click", () => {
      selectMode = true;
      selectedForDelete.clear();
      confirmingBulk = false;
      renderSessionList();
    });
    wrap.appendChild(start);
    return wrap;
  }

  const del = document.createElement("button");
  del.className = "list-action danger";
  del.textContent = `Delete (${selectedForDelete.size})`;
  del.disabled = selectedForDelete.size === 0;
  del.addEventListener("click", () => {
    if (selectedForDelete.size === 0) return;
    confirmingBulk = true;
    renderSessionList();
  });

  const all = document.createElement("button");
  all.className = "list-action";
  const allSelected = filtered.every((s) => selectedForDelete.has(s.path));
  all.textContent = allSelected ? "None" : "All";
  all.addEventListener("click", () => {
    if (allSelected) filtered.forEach((s) => selectedForDelete.delete(s.path));
    else filtered.forEach((s) => selectedForDelete.add(s.path));
    renderSessionList();
  });

  const cancel = document.createElement("button");
  cancel.className = "list-action";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", exitSelectMode);

  wrap.append(all, del, cancel);
  return wrap;
}

function toggleForDelete(s: SessionMeta) {
  if (selectedForDelete.has(s.path)) selectedForDelete.delete(s.path);
  else selectedForDelete.add(s.path);
  renderSessionList();
}

function exitSelectMode() {
  selectMode = false;
  confirmingBulk = false;
  selectedForDelete.clear();
  renderSessionList();
}

/** Move each chosen source to Trash, then leave select mode. */
async function bulkDelete(paths: string[]) {
  const failures: string[] = [];
  for (const p of paths) {
    try {
      await invoke("delete_session", { path: p });
    } catch {
      failures.push(p);
    }
  }
  const deleted = new Set(paths.filter((p) => !failures.includes(p)));
  sessions = sessions.filter((x) => !deleted.has(x.path));
  if (selected && deleted.has(selected.path)) {
    selected = null;
    viewer.classList.add("hidden");
    emptyState.classList.remove("hidden");
  }
  exitSelectMode();
  if (failures.length) {
    setStatus(`Could not delete ${failures.length} of ${paths.length} sources.`, "error");
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/** Replace a session row with an inline "Move to Trash?" confirmation. */
function confirmDelete(item: HTMLElement, s: SessionMeta) {
  item.classList.add("confirming");
  item.innerHTML = `
    <span class="confirm-text">Move to Trash?</span>
    <span class="confirm-actions">
      <button class="confirm-yes">Trash</button>
      <button class="confirm-no">Cancel</button>
    </span>`;
  item.querySelector(".confirm-no")!.addEventListener("click", (e) => {
    e.stopPropagation();
    renderSessionList();
  });
  item.querySelector(".confirm-yes")!.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await invoke("delete_session", { path: s.path });
      sessions = sessions.filter((x) => x.path !== s.path);
      if (selected?.path === s.path) {
        selected = null;
        viewer.classList.add("hidden");
        emptyState.classList.remove("hidden");
      }
    } catch (err) {
      setStatus(`Could not delete session: ${err}`, "error");
    }
    renderSessionList();
  });
}

function setStatus(msg: string, kind: "info" | "error" | "" = "info") {
  if (!msg) {
    statusBar.classList.add("hidden");
    return;
  }
  statusBar.textContent = msg;
  statusBar.className = `status-bar ${kind}`;
}

/** Render a spinner + live elapsed timer into a container. Returns a stop fn. */
function renderLoading(container: HTMLElement, label: string): () => void {
  container.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div class="loading-label">${escapeHtml(label)}</div>
      <div class="loading-sub">Elapsed <span class="loading-timer">0s</span> · ${MODEL_LABELS[model]} model</div>
    </div>`;
  const timerEl = container.querySelector(".loading-timer")!;
  const start = Date.now();
  const id = window.setInterval(() => {
    timerEl.textContent = `${Math.round((Date.now() - start) / 1000)}s`;
  }, 500);
  return () => window.clearInterval(id);
}

async function selectSession(s: SessionMeta) {
  selected = s;
  renderSessionList();
  emptyState.classList.add("hidden");
  viewer.classList.remove("hidden");
  viewerTitle.textContent = s.title;
  viewerSub.textContent = `${s.project} · ${fmtDate(s.modified)}`;
  const link = isLinkSource(s);
  $("#refresh-source-btn").classList.toggle("hidden", !link);
  transcriptFilterBar.classList.toggle("hidden", link);
  // The last tab is "Source" for imported links, "Transcript" for sessions.
  $("#tab-transcript").textContent = link ? "Source" : "Transcript";

  // Reset per-source state.
  forest = null;
  treeCache = {};
  microworldCache = {};
  activeMicroworld = {};
  microworldStep = {};
  currentTreeId = null;
  busy = null;
  askHistory = [];
  asking = false;
  reflectState = {};
  reflecting = null;
  switchView("design");
  designView.innerHTML = "";
  renderAsk();
  clearTranscriptNavigation();
  transcriptBlocks = [];
  transcriptView.textContent = "Loading transcript…";

  // Prefetch the cached forest (no Claude call); if present, also prefetch its
  // cached trees so the picker can mark which are already generated.
  const cachedForest = await invoke<Forest | null>("cached_forest", { path: s.path, lang });
  if (selected?.path !== s.path) return; // user switched away
  forest = cachedForest;
  if (forest) {
    const trees = await Promise.all(
      forest.trees.map((t) =>
        invoke<Tree | null>("cached_tree", { path: s.path, treeId: t.id, lang }),
      ),
    );
    if (selected?.path !== s.path) return;
    forest.trees.forEach((t, i) => (treeCache[t.id] = trees[i]));
  }
  renderDesignTab();
  updateGenerateButton();

  // Last tab: structured messages for sessions, rendered markdown for links.
  transcriptView.innerHTML = `<p class="muted">Loading…</p>`;
  if (link) {
    invoke<string>("get_transcript", { path: s.path })
      .then((t) => {
        if (selected?.path === s.path)
          transcriptView.innerHTML = `<div class="level-content-inner transcript-md">${marked.parse(t) as string}</div>`;
      })
      .catch((e) => {
        if (selected?.path === s.path)
          transcriptView.innerHTML = `<p class="muted">Could not load source: ${escapeHtml(String(e))}</p>`;
      });
  } else {
    invoke<Msg[]>("get_messages", { path: s.path })
      .then((msgs) => {
        if (selected?.path === s.path) renderTranscript(msgs);
      })
      .catch((e) => {
        if (selected?.path === s.path)
          transcriptView.innerHTML = `<p class="muted">Could not load transcript: ${escapeHtml(String(e))}</p>`;
      });
  }
}

function renderTranscript(blocks: Msg[]) {
  transcriptBlocks = blocks;
  clearTranscriptNavigation();
  transcriptView.innerHTML = "";
  if (!blocks.length) {
    transcriptView.innerHTML = `<p class="muted">No messages in this session.</p>`;
    return;
  }
  const visible = new Set(filterTranscriptBlockIndices(blocks, transcriptFilterMode));
  let rendered = 0;
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.kind === "text") {
      const index = i++;
      if (!visible.has(index)) continue;
      const el = document.createElement("div");
      el.className = `msg msg-${b.role}`;
      el.innerHTML =
        `<div class="msg-role">${b.role === "user" ? "You" : "Claude"}</div>` +
        `<div class="msg-body">${marked.parse(b.text) as string}</div>`;
      transcriptView.appendChild(el);
      registerTranscriptNav(
        el,
        b.role === "user" ? "You" : "Claude",
        b.text,
        b.role,
      );
      rendered++;
    } else if (b.kind === "thinking") {
      const index = i++;
      if (!visible.has(index)) continue;
      const thinking = aside(
        "msg-thinking",
        `<span class="aside-badge">Thinking</span>`,
        `<div class="aside-body">${marked.parse(b.text) as string}</div>`,
      );
      transcriptView.appendChild(thinking);
      registerTranscriptNav(thinking, "Thinking", b.text, "thinking");
      rendered++;
    } else if (b.kind === "tool_use" || b.kind === "tool_result") {
      // Group a run of tool calls with the run of results that follows, so
      // each call and its result read as one connected pair.
      const calls: Array<{ block: Msg; index: number }> = [];
      while (i < blocks.length && blocks[i].kind === "tool_use") {
        calls.push({ block: blocks[i], index: i++ });
      }
      const results: Array<{ block: Msg; index: number }> = [];
      while (i < blocks.length && blocks[i].kind === "tool_result") {
        results.push({ block: blocks[i], index: i++ });
      }
      const n = Math.max(calls.length, results.length);
      for (let k = 0; k < n; k++) {
        const callEntry = calls[k];
        const resultEntry = results[k];
        if (
          !visible.has(callEntry?.index ?? -1) &&
          !visible.has(resultEntry?.index ?? -1)
        ) continue;
        const call = callEntry?.block;
        const result = resultEntry?.block;
        const pair = document.createElement("div");
        pair.className = "tool-pair" + (result?.is_error ? " error" : "");
        if (call) pair.appendChild(toolCall(call));
        if (result) pair.appendChild(toolResult(result));
        transcriptView.appendChild(pair);
        const toolName = call?.tool || "Tool result";
        const preview = [call?.subtitle || call?.text, result?.text]
          .filter(Boolean)
          .join(" — ");
        registerTranscriptNav(
          pair,
          `Tool · ${toolName}`,
          preview,
          result?.is_error ? "error" : "tool",
        );
        rendered++;
      }
    } else {
      i++;
    }
  }
  if (!rendered) {
    transcriptView.innerHTML = `<p class="muted">No design-relevant messages. Switch to All to inspect every event.</p>`;
    return;
  }
  window.requestAnimationFrame(buildTranscriptNavigation);
}

function registerTranscriptNav(
  element: HTMLElement,
  label: string,
  text: string,
  kind: TranscriptNavKind,
) {
  element.dataset.transcriptNav = kind;
  transcriptNavEntries.push({
    element,
    label,
    preview: compactTranscriptPreview(text),
    kind,
  });
}

function clearTranscriptNavigation() {
  if (transcriptNavFrame) window.cancelAnimationFrame(transcriptNavFrame);
  if (transcriptProgressFrame) window.cancelAnimationFrame(transcriptProgressFrame);
  transcriptNavFrame = 0;
  transcriptProgressFrame = 0;
  transcriptHoverMarker = -1;
  transcriptNavEntries = [];
  transcriptModeEntryIndices = [];
  transcriptNavMarkers = [];
  transcriptMapTrack.innerHTML = "";
  transcriptMap.classList.add("hidden");
  transcriptMapPreview.classList.add("hidden");
}

function buildTranscriptNavigation() {
  transcriptMapTrack.innerHTML = "";
  transcriptNavMarkers = [];
  transcriptModeEntryIndices = filterTranscriptEntryIndices(
    transcriptNavEntries.map((entry) => entry.kind),
    minimapMode,
  );
  if (transcriptModeEntryIndices.length < 2) {
    transcriptMap.classList.add("hidden");
    return;
  }

  for (const modePosition of sampleTranscriptEntries(transcriptModeEntryIndices.length)) {
    const entryIndex = transcriptModeEntryIndices[modePosition];
    const entry = transcriptNavEntries[entryIndex];
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `transcript-marker ${entry.kind}`;
    marker.dataset.entryIndex = String(entryIndex);
    marker.dataset.modePosition = String(modePosition);
    marker.setAttribute("aria-label", `Jump to ${entry.label}: ${entry.preview}`);
    marker.addEventListener("focus", () => showTranscriptPreview(marker, entryIndex));
    marker.addEventListener("blur", hideTranscriptPreview);
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      jumpToTranscriptEntry(entryIndex);
    });
    transcriptMapTrack.appendChild(marker);
    transcriptNavMarkers.push(marker);
  }
  transcriptMap.classList.remove("hidden");
  layoutTranscriptNavigation();
}

function layoutTranscriptNavigation() {
  if (!transcriptNavMarkers.length) return;
  const first = transcriptNavEntries[0].element.offsetTop;
  const last = transcriptNavEntries[transcriptNavEntries.length - 1]?.element.offsetTop ?? first;
  const span = Math.max(1, last - first);
  for (const marker of transcriptNavMarkers) {
    const entryIndex = Number(marker.dataset.entryIndex);
    const offset = transcriptNavEntries[entryIndex].element.offsetTop - first;
    marker.style.top = `${transcriptMarkerRatio(offset, span) * 100}%`;
  }
  updateTranscriptNavigation();
}

function updateTranscriptNavigation() {
  if (!transcriptNavMarkers.length) return;
  const sampledOffsets = transcriptNavMarkers.map((marker) => {
    const entryIndex = Number(marker.dataset.entryIndex);
    return transcriptNavEntries[entryIndex].element.offsetTop;
  });
  const focusY = transcriptView.scrollTop + transcriptView.clientHeight * 0.3;
  const activeMarker = findNearestTranscriptEntry(sampledOffsets, focusY);
  transcriptNavMarkers.forEach((marker, index) =>
    marker.classList.toggle("active", index === activeMarker),
  );
}

function scheduleTranscriptNavigation() {
  if (transcriptNavFrame) return;
  transcriptNavFrame = window.requestAnimationFrame(() => {
    transcriptNavFrame = 0;
    layoutTranscriptNavigation();
  });
}

function scheduleTranscriptProgress() {
  if (transcriptProgressFrame) return;
  transcriptProgressFrame = window.requestAnimationFrame(() => {
    transcriptProgressFrame = 0;
    updateTranscriptNavigation();
  });
}

function transcriptMarkerAt(clientY: number): number {
  if (!transcriptNavMarkers.length) return -1;
  const trackTop = transcriptMapTrack.getBoundingClientRect().top;
  return findNearestTranscriptEntry(
    transcriptNavMarkers.map((marker) => marker.offsetTop),
    clientY - trackTop,
  );
}

function jumpToTranscriptEntry(entryIndex: number) {
  const target = transcriptNavEntries[entryIndex]?.element;
  if (!target) return;
  transcriptView.scrollTo({
    top: Math.max(0, target.offsetTop - transcriptView.clientHeight * 0.3),
    behavior: "smooth",
  });
}

function showTranscriptPreview(marker: HTMLButtonElement, entryIndex: number) {
  const entry = transcriptNavEntries[entryIndex];
  if (!entry) return;
  transcriptNavMarkers.forEach((item) => item.classList.remove("hovered"));
  marker.classList.add("hovered");
  transcriptHoverMarker = transcriptNavMarkers.indexOf(marker);
  transcriptMapPreview.querySelector<HTMLElement>(".transcript-preview-label")!.textContent =
    `${entry.label} · ${Number(marker.dataset.modePosition) + 1}/${transcriptModeEntryIndices.length}`;
  transcriptMapPreview.querySelector<HTMLElement>(".transcript-preview-text")!.textContent =
    entry.preview || "No preview available";
  transcriptMapPreview.classList.remove("hidden");
  const trackHeight = transcriptMapTrack.clientHeight;
  const previewY = Math.min(Math.max(marker.offsetTop, 48), Math.max(48, trackHeight - 48));
  transcriptMapPreview.style.top = `${previewY}px`;
}

function hideTranscriptPreview() {
  transcriptNavMarkers.forEach((marker) => marker.classList.remove("hovered"));
  transcriptHoverMarker = -1;
  transcriptMapPreview.classList.add("hidden");
}

function toolCall(b: Msg): HTMLElement {
  const sub = b.subtitle ? `<code class="aside-sub">${escapeHtml(b.subtitle)}</code>` : "";
  return aside(
    "msg-tool",
    `<span class="aside-badge tool">${escapeHtml(b.tool || "tool")}</span>${sub}`,
    `<pre class="aside-code">${escapeHtml(b.text)}</pre>`,
  );
}

function toolResult(b: Msg): HTMLElement {
  return aside(
    "msg-result" + (b.is_error ? " error" : ""),
    `<span class="aside-badge">${b.is_error ? "Tool error" : "Tool result"}</span>`,
    `<pre class="aside-code">${escapeHtml(b.text)}</pre>`,
  );
}

/** A collapsible aside toggled by JS (WKWebView breaks <details> when the
 *  summary is a flex container, so we don't rely on native <details>). */
function aside(cls: string, summaryHTML: string, bodyHTML: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "msg-aside " + cls;
  const btn = document.createElement("button");
  btn.className = "aside-summary";
  btn.innerHTML = `<span class="aside-caret">▸</span>${summaryHTML}`;
  const body = document.createElement("div");
  body.className = "aside-content hidden";
  body.innerHTML = bodyHTML;
  btn.addEventListener("click", () => {
    const nowHidden = body.classList.toggle("hidden");
    wrap.classList.toggle("open", !nowHidden);
    if (transcriptView.contains(wrap)) scheduleTranscriptNavigation();
  });
  wrap.appendChild(btn);
  wrap.appendChild(body);
  return wrap;
}

// ---------- Diagrams (rendered inline inside design levels) ----------

let mermaidSeq = 0;

/** Render mermaid into `body`; on parse failure, ask the backend to repair it
 *  once and retry before giving up. */
async function renderMermaid(body: HTMLElement, src: HTMLElement, source: string): Promise<boolean> {
  try {
    const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, source);
    body.innerHTML = svg;
    return true;
  } catch {
    body.innerHTML = `<div class="unavailable">Fixing diagram syntax…</div>`;
    try {
      const fixed = await invoke<string>("fix_mermaid", { source, model });
      const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, fixed);
      body.innerHTML = svg;
      src.textContent = fixed;
      return true;
    } catch (e2) {
      body.innerHTML = `<div class="unavailable">Mermaid render failed: ${escapeHtml(String(e2))}</div>`;
      src.classList.remove("hidden");
      return false;
    }
  }
}

async function appendDiagramCard(container: HTMLElement, d: Diagram) {
  const card = document.createElement("section");
  card.className = "diagram-card";

  const head = document.createElement("div");
  head.className = "diagram-head";
  head.innerHTML = `
    <h3>${escapeHtml(d.title)}</h3>
    <span class="diagram-tools">
      <button class="mini-btn expand-btn hidden">⤢ Expand</button>
      <button class="mini-btn src-toggle">&lt;/&gt; Source</button>
    </span>`;
  card.appendChild(head);

  if (d.explanation) {
    const exp = document.createElement("p");
    exp.className = "diagram-exp";
    exp.textContent = d.explanation;
    card.appendChild(exp);
  }

  const body = document.createElement("div");
  body.className = "diagram-body";
  card.appendChild(body);

  const src = document.createElement("pre");
  src.className = "diagram-source hidden";
  src.textContent = d.source;
  card.appendChild(src);

  head.querySelector(".src-toggle")!.addEventListener("click", () => {
    src.classList.toggle("hidden");
  });

  container.appendChild(card);

  let rendered = false;
  if (d.unavailable) {
    body.innerHTML = `<div class="unavailable">⚠︎ ${escapeHtml(d.unavailable)}</div>`;
  } else if (d.kind === "mermaid") {
    rendered = await renderMermaid(body, src, d.source);
  } else if (d.kind === "mingrammer" && d.rendered) {
    body.innerHTML = d.rendered;
    rendered = true;
  } else {
    body.innerHTML = `<div class="unavailable">Nothing to render.</div>`;
  }

  if (rendered) {
    const expand = head.querySelector(".expand-btn")!;
    expand.classList.remove("hidden");
    expand.addEventListener("click", () => openLightbox(d.title, body.innerHTML));
  }
}

// ---------- Lightbox ----------

function openLightbox(title: string, html: string) {
  $("#lightbox-title").textContent = title;
  $("#lightbox-body").innerHTML = html;
  $("#lightbox").classList.remove("hidden");
}

function closeLightbox() {
  $("#lightbox").classList.add("hidden");
  $("#lightbox-body").innerHTML = "";
}

function switchView(view: View) {
  currentView = view;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.view === view);
  });
  designView.classList.toggle("hidden", view !== "design");
  askView.classList.toggle("hidden", view !== "ask");
  transcriptShell.classList.toggle("hidden", view !== "transcript");
  if (view === "transcript") scheduleTranscriptNavigation();
  else hideTranscriptPreview();
  updateGenerateButton();
}

/** Header Generate/Regenerate button: acts on the forest overview, or on the
 *  current tree when drilled in. Only shown on the Design tab while idle. */
function updateGenerateButton() {
  const btn = $<HTMLButtonElement>("#regen-btn");
  if (!selected || currentView !== "design" || busy) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  if (currentTreeId === null) {
    btn.textContent = forest ? "↻ Regenerate overview" : "Generate overview";
  } else {
    btn.textContent = treeCache[currentTreeId] ? "↻ Regenerate" : "Generate";
  }
}

// ---------- Design: forest (overview + trees) → tree drilldown ----------

let designLoadingStop: (() => void) | null = null;

function scrollPanel(): HTMLElement {
  const el = document.createElement("div");
  el.className = "design-scroll";
  return el;
}

function addStop(scroll: HTMLElement) {
  const cancel = document.createElement("button");
  cancel.className = "cancel-btn";
  cancel.textContent = "✕ Stop";
  cancel.addEventListener("click", cancelGeneration);
  scroll.querySelector(".loading")?.appendChild(cancel);
}

/** Append a markdown body (with hover terms + inline diagrams) into a panel. */
async function appendRichContent(
  scroll: HTMLElement,
  title: string,
  markdown: string,
  terms: Term[],
  diagrams: Diagram[],
) {
  const inner = document.createElement("div");
  inner.className = "level-content-inner";
  inner.innerHTML =
    `<h3 class="level-content-title">${escapeHtml(title)}</h3>` +
    (marked.parse(markdown || "") as string);
  annotateTerms(inner, terms || []);

  let wrap: HTMLElement | null = null;
  if (diagrams && diagrams.length) {
    wrap = document.createElement("div");
    wrap.className = "level-diagrams";
    const h = document.createElement("h4");
    h.className = "level-diagrams-title";
    h.textContent = diagrams.length > 1 ? "Diagrams" : "Diagram";
    wrap.appendChild(h);
    inner.appendChild(wrap);
  }
  scroll.appendChild(inner);
  if (wrap) for (const d of diagrams) await appendDiagramCard(wrap, d);
}

function renderDesignTab() {
  if (designLoadingStop) {
    designLoadingStop();
    designLoadingStop = null;
  }
  designView.innerHTML = "";

  if (busy?.kind === "forest") {
    const scroll = scrollPanel();
    designView.appendChild(scroll);
    designLoadingStop = renderLoading(scroll, "Generating the overview…");
    addStop(scroll);
    return;
  }
  if (!forest) {
    renderForestPlaceholder();
    return;
  }
  if (currentTreeId === null) {
    renderForestView();
  } else {
    renderTreeView();
  }
}

function renderForestPlaceholder() {
  const scroll = scrollPanel();
  scroll.innerHTML = `
    <div class="generate-prompt">
      <p>No overview generated for this source yet.</p>
      <button class="generate-btn">Generate overview</button>
      <p class="hint">Monet gives you the big picture, then lists the components
        worth exploring. Pick any one to drill into its details, with inline
        diagrams and hover-over term definitions. Cached after the first run.</p>
    </div>`;
  scroll.querySelector(".generate-btn")!.addEventListener("click", () =>
    generateForest(false),
  );
  designView.appendChild(scroll);
}

function renderForestView() {
  if (!forest) return;
  const scroll = scrollPanel();
  designView.appendChild(scroll);
  void appendRichContent(scroll, "Overview", forest.overview, forest.terms, forest.diagrams);

  const section = document.createElement("div");
  section.className = "tree-section";
  section.innerHTML = `<h4 class="tree-section-title">Explore in depth</h4>`;
  const list = document.createElement("div");
  list.className = "tree-list";
  for (const t of forest.trees) {
    const card = document.createElement("button");
    card.className = "tree-card" + (treeCache[t.id] ? " has-content" : "");
    card.innerHTML = `
      <span class="tree-name">${escapeHtml(t.name)}</span>
      <span class="tree-blurb">${escapeHtml(t.blurb || "")}</span>
      <span class="tree-row-end">${treeCache[t.id] ? '<span class="tree-cache-dot" title="Generated"></span>' : ""}<span class="tree-arrow">→</span></span>`;
    card.addEventListener("click", () => openTree(t.id));
    list.appendChild(card);
  }
  section.appendChild(list);
  scroll.appendChild(section);
}

function renderTreeView() {
  if (!forest || currentTreeId === null) return;
  const tref = forest.trees.find((t) => t.id === currentTreeId);
  const name = tref?.name ?? currentTreeId;

  const bar = document.createElement("div");
  bar.className = "tree-bar";
  bar.innerHTML = `<button class="tree-back">← Overview</button>
    <span class="tree-crumb">${escapeHtml(name)}</span>`;
  bar.querySelector(".tree-back")!.addEventListener("click", backToForest);
  designView.appendChild(bar);

  const scroll = scrollPanel();
  designView.appendChild(scroll);

  if (busy?.kind === "tree" && busy.id === currentTreeId) {
    designLoadingStop = renderLoading(scroll, `Exploring “${name}”…`);
    addStop(scroll);
    return;
  }
  const t = treeCache[currentTreeId];
  if (!t) {
    scroll.innerHTML = `
      <div class="generate-prompt">
        <p><b>${escapeHtml(name)}</b> isn't generated yet.</p>
        <button class="generate-btn">Generate</button>
      </div>`;
    scroll.querySelector(".generate-btn")!.addEventListener("click", () =>
      generateTree(currentTreeId!, name, false),
    );
    return;
  }
  void appendRichContent(scroll, t.name, t.content, t.terms, t.diagrams);
  renderMicroworlds(scroll, currentTreeId, t);
  renderReflect(scroll, currentTreeId);
}

// ---------- Microworld: step through a grounded flow and its state ----------

const microworldKey = (treeId: string, worldId: string) => `${treeId}::${worldId}`;

function renderMicroworlds(scroll: HTMLElement, treeId: string, tree: Tree) {
  const refs = tree.microworlds ?? [];
  if (refs.length === 0) return;

  const section = document.createElement("section");
  section.className = "microworld-section";
  section.innerHTML = `<div class="microworld-section-head">
      <div><h4>Explore the flow</h4><p>Move through the design and watch its state change.</p></div>
    </div>`;
  const activeId = activeMicroworld[treeId];
  if (!activeId) {
    const choices = document.createElement("div");
    choices.className = "microworld-choices";
    for (const ref of refs) {
      const button = document.createElement("button");
      button.className = "microworld-choice";
      button.innerHTML = `<span class="microworld-choice-title">${escapeHtml(ref.title)}</span>
        <span>${escapeHtml(ref.blurb)}</span><span class="microworld-choice-action">Step through →</span>`;
      button.addEventListener("click", () => void openMicroworld(treeId, tree.name, ref));
      choices.appendChild(button);
    }
    section.appendChild(choices);
  } else {
    const ref = refs.find((item) => item.id === activeId);
    const key = microworldKey(treeId, activeId);
    const head = document.createElement("div");
    head.className = "microworld-active-head";
    head.innerHTML = `<button class="microworld-close">← All flows</button>`;
    head.querySelector("button")!.addEventListener("click", () => {
      activeMicroworld[treeId] = null;
      renderDesignTab();
    });
    section.appendChild(head);

    if (busy?.kind === "microworld" && busy.treeId === treeId && busy.worldId === activeId) {
      const loading = document.createElement("div");
      loading.className = "microworld-loading";
      designLoadingStop = renderLoading(loading, `Building “${ref?.title ?? activeId}”…`);
      addStop(loading);
      section.appendChild(loading);
    } else if (microworldCache[key]) {
      section.appendChild(renderMicroworldPlayer(treeId, activeId, microworldCache[key]!));
    } else if (ref) {
      const retry = document.createElement("div");
      retry.className = "generate-prompt compact";
      retry.innerHTML = `<p>This flow isn't generated yet.</p><button class="generate-btn">Generate</button>`;
      retry.querySelector("button")!.addEventListener("click", () =>
        void generateMicroworld(treeId, tree.name, ref, false),
      );
      section.appendChild(retry);
    }
  }
  scroll.appendChild(section);
}

function renderMicroworldPlayer(
  treeId: string,
  worldId: string,
  world: Microworld,
): HTMLElement {
  const key = microworldKey(treeId, worldId);
  const index = Math.max(0, Math.min(microworldStep[key] ?? 0, world.steps.length - 1));
  microworldStep[key] = index;
  const step = world.steps[index];
  const player = document.createElement("div");
  player.className = "microworld-player";

  const top = document.createElement("div");
  top.className = "microworld-player-head";
  top.innerHTML = `<div><h5>${escapeHtml(world.title)}</h5><p>${escapeHtml(world.intro)}</p></div>
    <span class="microworld-count">${index + 1} / ${world.steps.length}</span>`;
  player.appendChild(top);

  const timeline = document.createElement("div");
  timeline.className = "microworld-timeline";
  world.steps.forEach((item, itemIndex) => {
    const button = document.createElement("button");
    button.className = itemIndex === index ? "active" : itemIndex < index ? "seen" : "";
    button.title = item.label;
    button.setAttribute("aria-label", `Step ${itemIndex + 1}: ${item.label}`);
    button.addEventListener("click", () => setMicroworldStep(key, itemIndex));
    timeline.appendChild(button);
  });
  player.appendChild(timeline);

  const panels = document.createElement("div");
  panels.className = "microworld-panels";
  const story = document.createElement("article");
  story.className = "microworld-panel microworld-story";
  story.innerHTML = `<span class="microworld-eyebrow">Step ${index + 1}</span>
    <h6>${escapeHtml(step.label)}</h6><div>${marked.parse(step.detail) as string}</div>`;
  panels.appendChild(story);
  panels.appendChild(renderMicroworldState(world.steps, index));
  panels.appendChild(renderMicroworldFlow(world, index));
  player.appendChild(panels);

  const nav = document.createElement("div");
  nav.className = "microworld-nav";
  nav.innerHTML = `<button class="ghost-btn prev" ${index === 0 ? "disabled" : ""}>← Previous</button>
    <button class="ghost-btn next" ${index === world.steps.length - 1 ? "disabled" : ""}>Next →</button>`;
  nav.querySelector(".prev")!.addEventListener("click", () => setMicroworldStep(key, index - 1));
  nav.querySelector(".next")!.addEventListener("click", () => setMicroworldStep(key, index + 1));
  player.appendChild(nav);
  return player;
}

function renderMicroworldState(steps: MicroworldStep[], index: number): HTMLElement {
  const panel = document.createElement("article");
  panel.className = "microworld-panel microworld-state";
  panel.innerHTML = `<span class="microworld-eyebrow">State snapshot</span>`;
  const rows = document.createElement("div");
  rows.className = "microworld-state-rows";
  for (const row of microworldStateRows(steps, index)) {
    const item = document.createElement("div");
    item.className = "microworld-state-row" + (row.changed ? " changed" : "");
    item.innerHTML = `<code>${escapeHtml(row.key)}</code><span class="state-values">${
      row.changed && row.before !== null
        ? `<del>${escapeHtml(row.before)}</del><span>→</span>`
        : ""
    }<strong>${escapeHtml(row.value ?? "removed")}</strong></span>`;
    rows.appendChild(item);
  }
  panel.appendChild(rows);
  return panel;
}

function renderMicroworldFlow(world: Microworld, index: number): HTMLElement {
  const step = world.steps[index];
  const panel = document.createElement("article");
  panel.className = "microworld-panel microworld-flow";
  panel.innerHTML = `<span class="microworld-eyebrow">Actor transition</span>`;
  const lanes = document.createElement("div");
  lanes.className = "microworld-actors";
  for (const actor of world.actors) {
    const item = document.createElement("div");
    item.className = "microworld-actor" +
      (actor === step.from ? " from" : actor === step.to ? " to" : "");
    item.innerHTML = `<span>${escapeHtml(actor)}</span>`;
    lanes.appendChild(item);
  }
  const transition = document.createElement("div");
  transition.className = "microworld-transition";
  transition.innerHTML = `<strong>${escapeHtml(step.from)}</strong><span>→</span><strong>${escapeHtml(step.to)}</strong>`;
  panel.append(lanes, transition);
  return panel;
}

function setMicroworldStep(key: string, index: number) {
  const world = microworldCache[key];
  if (!world) return;
  microworldStep[key] = Math.max(0, Math.min(index, world.steps.length - 1));
  renderDesignTab();
}

async function openMicroworld(treeId: string, treeName: string, ref: MicroworldRef) {
  activeMicroworld[treeId] = ref.id;
  const key = microworldKey(treeId, ref.id);
  if (microworldCache[key]) {
    renderDesignTab();
    return;
  }
  if (!selected || busy) return;
  const s = selected;
  let cached: Microworld | null = null;
  try {
    cached = await invoke<Microworld | null>("cached_microworld", {
      path: s.path,
      treeId,
      worldId: ref.id,
      lang,
    });
  } catch {
    // A cache miss and an unreadable old cache both fall through to generation.
  }
  if (selected?.path !== s.path) return;
  if (cached) {
    microworldCache[key] = cached;
    renderDesignTab();
  } else {
    await generateMicroworld(treeId, treeName, ref, false);
  }
}

async function generateMicroworld(
  treeId: string,
  treeName: string,
  ref: MicroworldRef,
  force: boolean,
) {
  if (!selected || busy) return;
  const s = selected;
  busy = { kind: "microworld", treeId, worldId: ref.id };
  activeMicroworld[treeId] = ref.id;
  renderDesignTab();
  try {
    const world = await invoke<Microworld>("generate_microworld", {
      path: s.path,
      treeId,
      treeName,
      worldId: ref.id,
      title: ref.title,
      blurb: ref.blurb,
      force,
      model,
      lang,
    });
    if (selected?.path !== s.path) return;
    microworldCache[microworldKey(treeId, ref.id)] = world;
  } catch (e) {
    if (selected?.path === s.path) setStatus(String(e), "error");
  } finally {
    if (selected?.path === s.path) {
      busy = null;
      renderDesignTab();
    }
  }
}

// ---------- Reflect: active recall in service of participation ----------

function ensureReflect(treeId: string): ReflectThreads {
  if (!reflectState[treeId]) reflectState[treeId] = { teach_back: [], propose_next: [] };
  return reflectState[treeId];
}

/** Append the Reflect section (teach-back + propose-next) after a tree's body. */
function renderReflect(scroll: HTMLElement, treeId: string) {
  ensureReflect(treeId);
  const section = document.createElement("div");
  section.className = "reflect-section";
  section.innerHTML = `<h4 class="reflect-section-title">Reflect</h4>
    <p class="reflect-section-hint">Understanding is for taking part, not just
      approving. Put it in your own words, then say what you'd do next — Claude
      responds with formative feedback, never a grade.</p>`;
  section.appendChild(
    reflectBlock(treeId, "teach_back", "Explain it back",
      "Describe this component in your own words. Claude flags what you nailed and what's worth adding.",
      "In my understanding, this works by…"),
  );
  section.appendChild(
    reflectBlock(treeId, "propose_next", "Propose the next change",
      "Now that you get it — what would you change or build next? Claude checks how it fits the current design.",
      "Next, I'd like to…"),
  );
  scroll.appendChild(section);
}

function reflectBlock(
  treeId: string,
  mode: ReflectMode,
  heading: string,
  desc: string,
  placeholder: string,
): HTMLElement {
  const block = document.createElement("div");
  block.className = "reflect-block";
  block.innerHTML = `
    <div class="reflect-head">${escapeHtml(heading)}</div>
    <div class="reflect-desc">${escapeHtml(desc)}</div>
    <div class="reflect-thread" data-mode="${mode}"></div>
    <form class="reflect-input" data-mode="${mode}">
      <textarea rows="2" placeholder="${escapeHtml(placeholder)}"></textarea>
      <button type="submit" class="ghost-btn">Send</button>
    </form>`;
  const form = block.querySelector("form") as HTMLFormElement;
  const ta = block.querySelector("textarea") as HTMLTextAreaElement;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (text) {
      ta.value = "";
      sendReflect(treeId, mode, text);
    }
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  renderReflectThreadInto(block.querySelector(`.reflect-thread`) as HTMLElement, treeId, mode);
  return block;
}

/** Find the live thread element for a tree/mode, if the Reflect section for
 *  that tree is currently on screen. */
function reflectThreadEl(treeId: string, mode: ReflectMode): HTMLElement | null {
  if (currentTreeId !== treeId) return null;
  return designView.querySelector(`.reflect-thread[data-mode="${mode}"]`);
}

function renderReflectThreadInto(thread: HTMLElement, treeId: string, mode: ReflectMode) {
  const turns = ensureReflect(treeId)[mode];
  thread.innerHTML = "";
  for (const turn of turns) {
    const el = document.createElement("div");
    el.className = `reflect-turn ${turn.role}`;
    el.innerHTML =
      turn.role === "user" ? escapeHtml(turn.content) : (marked.parse(turn.content) as string);
    thread.appendChild(el);
  }
  if (reflecting && reflecting.treeId === treeId && reflecting.mode === mode) {
    const el = document.createElement("div");
    el.className = "reflect-turn assistant pending";
    el.innerHTML = `<span class="ask-dots"><span></span><span></span><span></span></span>`;
    thread.appendChild(el);
  }
}

function refreshReflectThread(treeId: string, mode: ReflectMode) {
  const thread = reflectThreadEl(treeId, mode);
  if (thread) renderReflectThreadInto(thread, treeId, mode);
}

async function sendReflect(treeId: string, mode: ReflectMode, input: string) {
  if (!selected || reflecting) return;
  const s = selected;
  const tref = forest?.trees.find((t) => t.id === treeId);
  const focus = tref?.name ?? "";
  const threads = ensureReflect(treeId);
  const history = threads[mode].slice(); // prior turns, before this one
  threads[mode].push({ role: "user", content: input });
  reflecting = { treeId, mode };
  refreshReflectThread(treeId, mode);
  try {
    const ans = await invoke<string>("reflect", {
      path: s.path,
      focus,
      mode,
      history,
      input,
      model,
      lang,
    });
    if (selected?.path !== s.path) return;
    threads[mode].push({ role: "assistant", content: ans });
  } catch (e) {
    if (selected?.path === s.path)
      threads[mode].push({ role: "assistant", content: `⚠︎ ${String(e)}` });
  } finally {
    if (selected?.path === s.path) {
      reflecting = null;
      refreshReflectThread(treeId, mode);
    }
  }
}

function openTree(id: string) {
  currentTreeId = id;
  if (treeCache[id]) {
    renderDesignTab();
    updateGenerateButton();
    return;
  }
  const tref = forest?.trees.find((t) => t.id === id);
  generateTree(id, tref?.name ?? id, false);
}

function backToForest() {
  currentTreeId = null;
  renderDesignTab();
  updateGenerateButton();
}

async function generateForest(force: boolean) {
  if (!selected || busy) return;
  const s = selected;
  setStatus("");
  busy = { kind: "forest" };
  currentTreeId = null;
  renderDesignTab();
  updateGenerateButton();
  try {
    const f = await invoke<Forest>("generate_forest", { path: s.path, force, model, lang });
    if (selected?.path !== s.path) {
      busy = null;
      return;
    }
    forest = f;
    treeCache = {};
    microworldCache = {};
    activeMicroworld = {};
    microworldStep = {};
    busy = null;
    renderDesignTab();
    updateGenerateButton();
  } catch (e) {
    if (selected?.path !== s.path) {
      busy = null;
      return;
    }
    busy = null;
    renderDesignTab();
    updateGenerateButton();
    setStatus(String(e), "error");
  }
}

async function generateTree(id: string, name: string, force: boolean) {
  if (!selected || busy) return;
  const s = selected;
  setStatus("");
  busy = { kind: "tree", id };
  currentTreeId = id;
  renderDesignTab();
  updateGenerateButton();
  try {
    const t = await invoke<Tree>("generate_tree", {
      path: s.path,
      treeId: id,
      treeName: name,
      force,
      model,
      lang,
    });
    if (selected?.path !== s.path) {
      busy = null;
      return;
    }
    treeCache[id] = t;
    for (const key of Object.keys(microworldCache)) {
      if (key.startsWith(`${id}::`)) delete microworldCache[key];
    }
    activeMicroworld[id] = null;
    busy = null;
    renderDesignTab();
    updateGenerateButton();
  } catch (e) {
    if (selected?.path !== s.path) {
      busy = null;
      return;
    }
    busy = null;
    renderDesignTab();
    updateGenerateButton();
    setStatus(String(e), "error");
  }
}

async function cancelGeneration() {
  try {
    await invoke("cancel_generation");
  } catch {
    /* the in-flight generate promise reports the outcome */
  }
}

// ---------- Inline term annotations (hover-to-define) ----------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap the first occurrence of each term in the prose with a hover anchor. */
function annotateTerms(root: HTMLElement, terms: Term[]) {
  const sorted = [...terms]
    .filter((t) => t.term && t.definition)
    .sort((a, b) => b.term.length - a.term.length);
  for (const t of sorted) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(t.term)}(?![A-Za-z0-9])`, "i");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !re.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const p = (node as Text).parentElement;
        if (!p || p.closest("code, pre, a, .term-anchor")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const node = walker.nextNode() as Text | null;
    if (!node) continue;
    const m = re.exec(node.nodeValue!);
    if (!m) continue;
    const matched = node.splitText(m.index);
    matched.splitText(m[0].length);
    const span = document.createElement("span");
    span.className = "term-anchor";
    span.textContent = matched.nodeValue;
    span.dataset.term = t.term;
    span.dataset.def = t.definition;
    matched.parentNode!.replaceChild(span, matched);
  }
}

let termPopover: HTMLElement | null = null;

function showTermPopover(anchor: HTMLElement) {
  hideTermPopover();
  const pop = document.createElement("div");
  pop.className = "term-popover";
  pop.innerHTML = `<div class="term-popover-name">${escapeHtml(anchor.dataset.term || "")}</div>
    <div class="term-popover-def">${escapeHtml(anchor.dataset.def || "")}</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12))}px`;
  const below = r.bottom + 6;
  pop.style.top =
    below + pop.offsetHeight > window.innerHeight - 8
      ? `${r.top - pop.offsetHeight - 6}px`
      : `${below}px`;
  termPopover = pop;
}

function hideTermPopover() {
  termPopover?.remove();
  termPopover = null;
}

// ---------- Ask tab (multi-turn Q&A over the source) ----------

function renderAsk() {
  askView.innerHTML = `
    <div class="ask-thread" id="ask-thread"></div>
    <form class="ask-input" id="ask-form">
      <textarea id="ask-q" rows="1" placeholder="Ask about this source…"></textarea>
      <button type="submit" class="ghost-btn" id="ask-send">Ask</button>
    </form>`;
  renderAskThread();
  const form = askView.querySelector("#ask-form") as HTMLFormElement;
  const ta = askView.querySelector("#ask-q") as HTMLTextAreaElement;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = ta.value.trim();
    if (q) {
      ta.value = "";
      sendAsk(q);
    }
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}

function renderAskThread() {
  const thread = askView.querySelector("#ask-thread") as HTMLElement | null;
  if (!thread) return;
  if (askHistory.length === 0 && !asking) {
    thread.innerHTML = `<p class="muted">Ask follow-up questions about this source.
      Monet answers using the document as context and remembers the conversation.</p>`;
    return;
  }
  thread.innerHTML = "";
  for (const turn of askHistory) {
    const el = document.createElement("div");
    el.className = `ask-turn ${turn.role}`;
    el.innerHTML =
      turn.role === "user"
        ? escapeHtml(turn.content)
        : (marked.parse(turn.content) as string);
    thread.appendChild(el);
  }
  if (asking) {
    const el = document.createElement("div");
    el.className = "ask-turn assistant pending";
    el.innerHTML = `<span class="ask-dots"><span></span><span></span><span></span></span>`;
    thread.appendChild(el);
  }
  thread.scrollTop = thread.scrollHeight;
}

async function sendAsk(question: string) {
  if (!selected || asking) return;
  const s = selected;
  const history = askHistory.slice(); // prior turns, before this question
  askHistory.push({ role: "user", content: question });
  asking = true;
  renderAskThread();
  try {
    const ans = await invoke<string>("ask", {
      path: s.path,
      history,
      question,
      model,
      lang,
    });
    if (selected?.path !== s.path) return;
    askHistory.push({ role: "assistant", content: ans });
  } catch (e) {
    if (selected?.path === s.path)
      askHistory.push({ role: "assistant", content: `⚠︎ ${String(e)}` });
  } finally {
    if (selected?.path === s.path) {
      asking = false;
      renderAskThread();
    }
  }
}

async function refreshSessions() {
  sessions = await invoke<SessionMeta[]>("list_sessions");
  renderSessionList();
}

async function refreshDeps() {
  const deps = await invoke<DepStatus>("check_deps");
  const el = $("#dep-status");
  const dot = (ok: boolean) => `<span class="dot ${ok ? "ok" : "bad"}"></span>`;
  el.innerHTML = `
    <div title="Required: drives diagram generation">${dot(deps.claude)} Claude CLI</div>
    <div title="Optional: needed for mingrammer infra diagrams">${dot(
      deps.graphviz && deps.diagrams_pkg,
    )} Infra diagrams</div>`;
}

// ---------- Auto-update ----------

async function checkForUpdates(manual: boolean) {
  const btn = $<HTMLButtonElement>("#update-btn");
  if (manual) {
    btn.disabled = true;
    btn.textContent = "Checking…";
  }
  try {
    const update = await check();
    if (update) {
      showUpdateBanner(update);
    } else if (manual) {
      btn.textContent = "Up to date ✓";
      setTimeout(() => (btn.textContent = "Check for updates"), 2500);
    }
  } catch (e) {
    if (manual) {
      btn.textContent = "Check failed";
      setTimeout(() => (btn.textContent = "Check for updates"), 2500);
      console.error("update check failed", e);
    }
    // Silent on startup (e.g. offline, or no release published yet).
  } finally {
    if (manual) btn.disabled = false;
  }
}

function showUpdateBanner(update: Update) {
  document.getElementById("update-banner")?.remove();
  const banner = document.createElement("div");
  banner.id = "update-banner";
  banner.innerHTML = `
    <span>Update available: <b>v${escapeHtml(update.version)}</b></span>
    <span class="update-actions">
      <button id="update-install">Install & Restart</button>
      <button id="update-dismiss">Later</button>
    </span>`;
  document.body.appendChild(banner);

  banner.querySelector("#update-dismiss")!.addEventListener("click", () =>
    banner.remove(),
  );
  banner.querySelector("#update-install")!.addEventListener("click", async () => {
    const install = banner.querySelector<HTMLButtonElement>("#update-install")!;
    install.disabled = true;
    install.textContent = "Downloading…";
    try {
      await update.downloadAndInstall();
      install.textContent = "Restarting…";
      await relaunch();
    } catch (e) {
      install.disabled = false;
      install.textContent = "Retry";
      console.error("update install failed", e);
    }
  });
}

function updateModelUI() {
  document.querySelectorAll("#model-select button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.model === model);
  });
}

function updateLangUI() {
  document.querySelectorAll("#lang-select button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.lang === lang);
  });
}

function updateMinimapModeUI() {
  document.querySelectorAll<HTMLButtonElement>("#minimap-mode-select button").forEach((button) => {
    const active = button.dataset.minimapMode === minimapMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

function updateTranscriptFilterUI() {
  document.querySelectorAll<HTMLButtonElement>("#transcript-filter-select button").forEach((button) => {
    const active = button.dataset.transcriptFilter === transcriptFilterMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

function openSettings() {
  updateLangUI();
  updateMinimapModeUI();
  $("#settings-modal").classList.remove("hidden");
}

async function importLink() {
  const urls = $<HTMLTextAreaElement>("#import-url")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const title = $<HTMLInputElement>("#import-title").value.trim() || null;
  const status = $("#import-status");
  if (urls.length === 0) return;
  status.textContent = "Adding…";
  try {
    const meta = await invoke<SessionMeta>("import_link", { urls, title });
    status.textContent = "";
    $("#import-modal").classList.add("hidden");
    $<HTMLTextAreaElement>("#import-url").value = "";
    $<HTMLInputElement>("#import-title").value = "";
    // Switch to the Links tab so the new source is visible.
    sourceTab = "links";
    document
      .querySelectorAll("#source-nav button")
      .forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.tab === "links"));
    $("#import-link-btn").classList.remove("hidden");
    await refreshSessions();
    selectSession(meta);
  } catch (e) {
    status.textContent = String(e);
  }
}

function wireUi() {
  filterInput.addEventListener("input", renderSessionList);
  transcriptView.addEventListener("scroll", scheduleTranscriptProgress, { passive: true });
  transcriptMapTrack.addEventListener("mousemove", (event) => {
    const markerIndex = transcriptMarkerAt(event.clientY);
    if (markerIndex < 0 || markerIndex === transcriptHoverMarker) return;
    const marker = transcriptNavMarkers[markerIndex];
    showTranscriptPreview(marker, Number(marker.dataset.entryIndex));
  });
  transcriptMapTrack.addEventListener("mouseleave", hideTranscriptPreview);
  transcriptMapTrack.addEventListener("click", (event) => {
    const markerIndex = transcriptMarkerAt(event.clientY);
    if (markerIndex < 0) return;
    jumpToTranscriptEntry(Number(transcriptNavMarkers[markerIndex].dataset.entryIndex));
  });
  window.addEventListener("resize", scheduleTranscriptNavigation);
  $("#refresh-btn").addEventListener("click", refreshSessions);
  // Shared Generate / Regenerate, acting on the forest or the current tree.
  $("#regen-btn").addEventListener("click", () => {
    if (currentView !== "design") return;
    if (currentTreeId === null) {
      generateForest(!!forest);
    } else {
      const t = forest?.trees.find((x) => x.id === currentTreeId);
      generateTree(currentTreeId, t?.name ?? currentTreeId, !!treeCache[currentTreeId]);
    }
  });
  $("#update-btn").addEventListener("click", () => checkForUpdates(true));

  // Hover-to-define term anchors inside the design content.
  designView.addEventListener("mouseover", (e) => {
    const a = (e.target as HTMLElement).closest(".term-anchor");
    if (a) showTermPopover(a as HTMLElement);
  });
  designView.addEventListener("mouseout", (e) => {
    if ((e.target as HTMLElement).closest(".term-anchor")) hideTermPopover();
  });
  $("#refresh-source-btn").addEventListener("click", async () => {
    if (!selected) return;
    try {
      await invoke("refresh_source", { path: selected.path });
      selectSession(selected); // mtime bumped -> caches miss -> re-fetch on next generate
    } catch (e) {
      setStatus(String(e), "error");
    }
  });
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () =>
      switchView((t as HTMLElement).dataset.view as View),
    );
  });
  document.querySelectorAll("#model-select button").forEach((b) => {
    b.addEventListener("click", () => {
      model = (b as HTMLElement).dataset.model as Model;
      localStorage.setItem("bp-model", model);
      updateModelUI();
    });
  });
  document.querySelectorAll("#lang-select button").forEach((b) => {
    b.addEventListener("click", () => {
      lang = (b as HTMLElement).dataset.lang as Lang;
      localStorage.setItem("bp-lang", lang);
      updateLangUI();
      // Generated content is cached per language — reload the selected source.
      if (selected) selectSession(selected);
    });
  });
  document.querySelectorAll("#minimap-mode-select button").forEach((b) => {
    b.addEventListener("click", () => {
      minimapMode = (b as HTMLElement).dataset.minimapMode as TranscriptMinimapMode;
      localStorage.setItem("bp-minimap-mode", minimapMode);
      updateMinimapModeUI();
      buildTranscriptNavigation();
    });
  });
  document.querySelectorAll("#transcript-filter-select button").forEach((b) => {
    b.addEventListener("click", () => {
      transcriptFilterMode = (b as HTMLElement).dataset
        .transcriptFilter as TranscriptFilterMode;
      localStorage.setItem("monet-transcript-filter", transcriptFilterMode);
      updateTranscriptFilterUI();
      if (transcriptBlocks.length) renderTranscript(transcriptBlocks);
    });
  });

  // Settings modal
  $("#settings-btn").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", () =>
    $("#settings-modal").classList.add("hidden"),
  );

  // Source tabs (Sessions / Links)
  document.querySelectorAll("#source-nav button").forEach((b) => {
    b.addEventListener("click", () => {
      sourceTab = (b as HTMLElement).dataset.tab as "sessions" | "links";
      document
        .querySelectorAll("#source-nav button")
        .forEach((x) => x.classList.toggle("active", x === b));
      $("#import-link-btn").classList.toggle("hidden", sourceTab !== "links");
      // Leave select mode when switching lists (chosen paths belong to a tab).
      selectMode = false;
      confirmingBulk = false;
      selectedForDelete.clear();
      renderSessionList();
    });
  });

  // Import-from-link modal
  $("#import-link-btn").addEventListener("click", () =>
    $("#import-modal").classList.remove("hidden"),
  );
  $("#import-modal-close").addEventListener("click", () =>
    $("#import-modal").classList.add("hidden"),
  );
  $("#import-go").addEventListener("click", importLink);

  // Backdrop click closes modals
  document.querySelectorAll(".modal").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) (m as HTMLElement).classList.add("hidden");
    });
  });

  $("#lightbox-close").addEventListener("click", closeLightbox);
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeLightbox();
      document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  wireUi();
  updateModelUI();
  updateMinimapModeUI();
  updateTranscriptFilterUI();
  refreshSessions();
  refreshDeps();
  checkForUpdates(false);
  // Show the current version on the update button's hover tooltip.
  getVersion()
    .then((v) => {
      $<HTMLButtonElement>("#update-btn").title = `Monet v${v}`;
    })
    .catch(() => {});
});

import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import mermaid from "mermaid";
import { marked } from "marked";

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

/** One generated design level: prose + that level's diagrams + terms. */
type LevelResult = {
  level: string;
  title: string;
  content: string;
  diagrams: Diagram[];
  terms: Term[];
};

type AskTurn = { role: "user" | "assistant"; content: string };

type DepStatus = {
  claude: boolean;
  python: boolean;
  graphviz: boolean;
  diagrams_pkg: boolean;
};

let sessions: SessionMeta[] = [];
let selected: SessionMeta | null = null;
let sourceTab: "sessions" | "links" = "sessions";
const isLinkSource = (s: SessionMeta) => s.path.endsWith(".links.json");
type View = "design" | "ask" | "transcript";
let currentView: View = "design";

// The three design levels (stable key + display name).
const LEVELS = [
  { key: "high", name: "High-level" },
  { key: "detailed", name: "Detailed" },
  { key: "impl", name: "Implementation" },
] as const;
type LevelKey = (typeof LEVELS)[number]["key"];

// In-memory per-level results for the selected source (null = not generated).
let levelCache: Record<string, LevelResult | null> = {};
let levelIndex = 0;
// Which level key is mid-generation (empty when idle).
let generatingLevel: LevelKey | null = null;

// Ask tab conversation for the selected source.
let askHistory: AskTurn[] = [];
let asking = false;

const collapsedGroups = new Set<string>();

type Lang = "en" | "ko";
const savedLang = localStorage.getItem("bp-lang");
let lang: Lang = savedLang === "ko" ? "ko" : "en";

type Model = "haiku" | "sonnet" | "opus";
const MODEL_LABELS: Record<Model, string> = {
  haiku: "Fast",
  sonnet: "Balanced",
  opus: "Best",
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
const transcriptView = $<HTMLPreElement>("#transcript-view");

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

  // Group by project.
  const groups = new Map<string, SessionMeta[]>();
  for (const s of filtered) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project)!.push(s);
  }

  sessionList.innerHTML = "";
  if (filtered.length === 0) {
    sessionList.innerHTML =
      sourceTab === "links"
        ? `<p class="muted">No imported links yet. Use “+ Import from link”.</p>`
        : `<p class="muted">No sessions found.</p>`;
    return;
  }

  for (const [project, items] of groups) {
    const collapsed = collapsedGroups.has(project);
    const groupEl = document.createElement("div");
    groupEl.className = "session-group" + (collapsed ? " collapsed" : "");

    const label = document.createElement("button");
    label.className = "group-label";
    label.innerHTML = `
      <span class="group-caret">▼</span>
      <span>${escapeHtml(project)}</span>
      <span class="group-count">${items.length}</span>`;
    label.addEventListener("click", () => {
      if (collapsedGroups.has(project)) collapsedGroups.delete(project);
      else collapsedGroups.add(project);
      renderSessionList();
    });
    groupEl.appendChild(label);

    const itemsEl = document.createElement("div");
    itemsEl.className = "group-items";
    for (const s of items) {
      const item = document.createElement("div");
      item.className =
        "session-item" + (selected?.path === s.path ? " active" : "");

      const open = document.createElement("button");
      open.className = "session-open";
      open.innerHTML = `
        <span class="session-title">${escapeHtml(s.title)}</span>
        <span class="session-meta">${fmtDate(s.modified)} · ${s.message_count} msgs</span>`;
      open.addEventListener("click", () => selectSession(s));

      const del = document.createElement("button");
      del.className = "session-del";
      del.title = "Move session to Trash";
      del.textContent = "🗑";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDelete(item, s);
      });

      item.appendChild(open);
      item.appendChild(del);
      itemsEl.appendChild(item);
    }
    groupEl.appendChild(itemsEl);
    sessionList.appendChild(groupEl);
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
  // The last tab is "Source" for imported links, "Transcript" for sessions.
  $("#tab-transcript").textContent = link ? "Source" : "Transcript";

  // Reset per-source state.
  levelCache = {};
  levelIndex = 0;
  generatingLevel = null;
  askHistory = [];
  asking = false;
  switchView("design");
  designView.innerHTML = "";
  renderAsk();
  transcriptView.textContent = "Loading transcript…";

  // Prefetch cached levels (no Claude calls) so the selector can mark which are
  // already generated, then render the Design tab.
  const results = await Promise.all(
    LEVELS.map((l) =>
      invoke<LevelResult | null>("cached_level", { path: s.path, level: l.key, lang }),
    ),
  );
  if (selected?.path !== s.path) return; // user switched away
  LEVELS.forEach((l, i) => (levelCache[l.key] = results[i]));
  renderDesign();
  updateGenerateButton();

  // Load the raw transcript/source lazily for the last tab.
  invoke<string>("get_transcript", { path: s.path })
    .then((t) => {
      if (selected?.path === s.path) transcriptView.textContent = t;
    })
    .catch((e) => {
      if (selected?.path === s.path)
        transcriptView.textContent = `Could not load transcript: ${e}`;
    });
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
  transcriptView.classList.toggle("hidden", view !== "transcript");
  updateGenerateButton();
}

/** Header Generate/Regenerate button acts on the CURRENT design level; only
 *  shown on the Design tab while idle. */
function updateGenerateButton() {
  const btn = $<HTMLButtonElement>("#regen-btn");
  if (!selected || currentView !== "design" || generatingLevel) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const key = LEVELS[levelIndex].key;
  btn.textContent = levelCache[key] ? "↻ Regenerate" : "✦ Generate";
}

// ---------- Design levels (per-level, on demand) ----------

let levelLoadingStop: (() => void) | null = null;

function renderDesign() {
  designView.innerHTML = "";
  const nav = document.createElement("div");
  nav.className = "level-nav";
  LEVELS.forEach((l, i) => {
    const b = document.createElement("button");
    b.className = `level-tab level-${i}` + (levelCache[l.key] ? " has-content" : "");
    b.innerHTML = `<span class="level-num">${i + 1}</span> ${escapeHtml(l.name)}`;
    b.addEventListener("click", () => {
      levelIndex = i;
      showLevel();
      updateGenerateButton();
    });
    nav.appendChild(b);
  });
  const content = document.createElement("div");
  content.className = "level-content";
  designView.appendChild(nav);
  designView.appendChild(content);
  showLevel();
}

function showLevel() {
  if (levelLoadingStop) {
    levelLoadingStop();
    levelLoadingStop = null;
  }
  const nav = designView.querySelector(".level-nav");
  const content = designView.querySelector(".level-content") as HTMLElement | null;
  if (!content) return;
  nav?.querySelectorAll("button").forEach((b, i) =>
    b.classList.toggle("active", i === levelIndex),
  );
  content.scrollTop = 0;

  const l = LEVELS[levelIndex];
  if (generatingLevel === l.key) {
    content.innerHTML = "";
    levelLoadingStop = renderLoading(content, `Generating the ${l.name} level…`);
    const cancel = document.createElement("button");
    cancel.className = "cancel-btn";
    cancel.textContent = "✕ Stop";
    cancel.addEventListener("click", cancelGeneration);
    content.querySelector(".loading")?.appendChild(cancel);
    return;
  }
  const res = levelCache[l.key];
  if (!res) {
    renderLevelPlaceholder(content, l);
    return;
  }
  renderLevelContent(content, res);
}

function renderLevelPlaceholder(content: HTMLElement, l: { key: string; name: string }) {
  content.innerHTML = `
    <div class="generate-prompt">
      <div class="generate-art">✦</div>
      <p>The <b>${escapeHtml(l.name)}</b> level isn't generated yet.</p>
      <button class="generate-btn">✦ Generate ${escapeHtml(l.name)}</button>
      <p class="hint">Monet asks your local Claude Code to explain this level from
        the document — with its diagrams inline and key terms you can hover for
        definitions. Cached after the first run.</p>
    </div>`;
  content.querySelector(".generate-btn")!.addEventListener("click", () =>
    generateLevel(l.key as LevelKey, false),
  );
}

async function renderLevelContent(content: HTMLElement, res: LevelResult) {
  content.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "level-content-inner";
  inner.innerHTML =
    `<h3 class="level-content-title">${escapeHtml(res.title)}</h3>` +
    (marked.parse(res.content || "") as string);
  annotateTerms(inner, res.terms || []);

  let wrap: HTMLElement | null = null;
  if (res.diagrams && res.diagrams.length) {
    wrap = document.createElement("div");
    wrap.className = "level-diagrams";
    const h = document.createElement("h4");
    h.className = "level-diagrams-title";
    h.textContent = res.diagrams.length > 1 ? "Diagrams for this level" : "Diagram for this level";
    wrap.appendChild(h);
    inner.appendChild(wrap);
  }
  content.appendChild(inner);
  if (wrap) for (const d of res.diagrams) await appendDiagramCard(wrap, d);
}

async function generateLevel(key: LevelKey, force: boolean) {
  if (!selected || generatingLevel) return;
  const s = selected;
  setStatus("");
  generatingLevel = key;
  levelIndex = LEVELS.findIndex((l) => l.key === key);
  showLevel();
  updateGenerateButton();
  try {
    const res = await invoke<LevelResult>("generate_level", {
      path: s.path,
      level: key,
      force,
      model,
      lang,
    });
    if (selected?.path !== s.path) {
      generatingLevel = null;
      return;
    }
    levelCache[key] = res;
    generatingLevel = null;
    renderDesign(); // refresh nav "has-content" markers + show the level
    updateGenerateButton();
  } catch (e) {
    if (selected?.path !== s.path) {
      generatingLevel = null;
      return;
    }
    generatingLevel = null;
    showLevel(); // back to placeholder
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

function openSettings() {
  updateLangUI();
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
  $("#refresh-btn").addEventListener("click", refreshSessions);
  // Shared Generate / Regenerate, acting on the current design level.
  $("#regen-btn").addEventListener("click", () => {
    const key = LEVELS[levelIndex].key;
    generateLevel(key, !!levelCache[key]);
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
  refreshSessions();
  refreshDeps();
  checkForUpdates(false);
});

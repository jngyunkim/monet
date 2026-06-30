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
  rendered: string;
  unavailable: string | null;
};

type DiagramSet = { diagrams: Diagram[] };

type Term = { term: string; definition: string; category: string };
type GlossarySet = { terms: Term[] };

type Level = { level: string; title: string; content: string };
type DesignDoc = { levels: Level[] };

type DepStatus = {
  claude: boolean;
  python: boolean;
  graphviz: boolean;
  diagrams_pkg: boolean;
};

let sessions: SessionMeta[] = [];
let selected: SessionMeta | null = null;
type View = "diagrams" | "design" | "terms" | "transcript";
let currentView: View = "diagrams";
let hasDiagrams = false;
let hasGlossary = false;
let hasDesign = false;
let termsLoadedForPath: string | null = null;
let designLoadedForPath: string | null = null;
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
const diagramsView = $("#diagrams-view");
const designView = $("#design-view");
const termsView = $("#terms-view");
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
  const filtered = sessions.filter(
    (s) =>
      !q ||
      s.title.toLowerCase().includes(q) ||
      s.project.toLowerCase().includes(q),
  );

  // Group by project.
  const groups = new Map<string, SessionMeta[]>();
  for (const s of filtered) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project)!.push(s);
  }

  sessionList.innerHTML = "";
  if (filtered.length === 0) {
    sessionList.innerHTML = `<p class="muted">No sessions found.</p>`;
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
  hasDiagrams = false;
  hasGlossary = false;
  hasDesign = false;
  termsLoadedForPath = null;
  designLoadedForPath = null;
  termsView.innerHTML = "";
  designView.innerHTML = "";
  switchView("diagrams");
  transcriptView.textContent = "Loading transcript…";
  await showDiagramsOrPrompt(s);
  // Load transcript lazily for the Transcript tab.
  invoke<string>("get_transcript", { path: s.path })
    .then((t) => {
      if (selected?.path === s.path) transcriptView.textContent = t;
    })
    .catch((e) => {
      if (selected?.path === s.path)
        transcriptView.textContent = `Could not load transcript: ${e}`;
    });
}

/** On selecting a session: show cached diagrams if present, else a Generate button. */
async function showDiagramsOrPrompt(s: SessionMeta) {
  setStatus("");
  diagramsView.innerHTML = "";
  const cached = await invoke<DiagramSet | null>("cached_diagrams", {
    path: s.path,
    lang,
  });
  if (selected?.path !== s.path) return; // user switched away
  if (cached && cached.diagrams && cached.diagrams.length > 0) {
    hasDiagrams = true;
    await renderDiagrams(cached);
  } else {
    showGeneratePrompt(s);
  }
  updateRegenButton();
}

function showGeneratePrompt(s: SessionMeta) {
  diagramsView.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "generate-prompt";
  wrap.innerHTML = `
    <p>No diagrams generated for this session yet.</p>
    <button class="generate-btn">✦ Generate Diagrams</button>
    <p class="hint">Blueprint asks your local Claude Code to read the design
      discussion and draw it. The result is cached, so it only runs once.</p>`;
  wrap.querySelector(".generate-btn")!.addEventListener("click", () =>
    loadDiagrams(s, false),
  );
  diagramsView.appendChild(wrap);
}

async function loadDiagrams(s: SessionMeta, force: boolean) {
  setStatus("");
  const stop = renderLoading(
    diagramsView,
    force ? "Regenerating diagrams…" : "Generating diagrams…",
  );
  try {
    const set = await invoke<DiagramSet>("generate_diagrams", {
      path: s.path,
      force,
      model,
      lang,
    });
    stop();
    if (selected?.path !== s.path) return; // user switched away
    hasDiagrams = true;
    updateRegenButton();
    await renderDiagrams(set);
  } catch (e) {
    stop();
    if (selected?.path !== s.path) return;
    diagramsView.innerHTML = "";
    setStatus(String(e), "error");
  }
}

async function renderDiagrams(set: DiagramSet) {
  diagramsView.innerHTML = "";
  if (!set.diagrams || set.diagrams.length === 0) {
    diagramsView.innerHTML = `<p class="muted">No diagrams were produced for this session.</p>`;
    return;
  }
  for (let i = 0; i < set.diagrams.length; i++) {
    const d = set.diagrams[i];
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

    diagramsView.appendChild(card);

    let rendered = false;
    if (d.unavailable) {
      body.innerHTML = `<div class="unavailable">⚠︎ ${escapeHtml(d.unavailable)}</div>`;
    } else if (d.kind === "mermaid") {
      try {
        const { svg } = await mermaid.render(`mmd-${i}-${Date.now()}`, d.source);
        body.innerHTML = svg;
        rendered = true;
      } catch (e) {
        body.innerHTML = `<div class="unavailable">Mermaid render failed: ${escapeHtml(
          String(e),
        )}</div>`;
        src.classList.remove("hidden");
      }
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
  diagramsView.classList.toggle("hidden", view !== "diagrams");
  designView.classList.toggle("hidden", view !== "design");
  termsView.classList.toggle("hidden", view !== "terms");
  transcriptView.classList.toggle("hidden", view !== "transcript");
  updateRegenButton();
  if (view === "terms" && selected && termsLoadedForPath !== selected.path) {
    showTermsOrPrompt(selected);
  }
  if (view === "design" && selected && designLoadedForPath !== selected.path) {
    showDesignOrPrompt(selected);
  }
}

/** The header Regenerate button acts on the active view and only shows when
 *  that view already has generated content. */
function updateRegenButton() {
  const btn = $("#regen-btn");
  const show =
    (currentView === "diagrams" && hasDiagrams) ||
    (currentView === "terms" && hasGlossary) ||
    (currentView === "design" && hasDesign);
  btn.classList.toggle("hidden", !show);
}

// ---------- Design levels ----------

async function showDesignOrPrompt(s: SessionMeta) {
  designLoadedForPath = s.path;
  setStatus("");
  designView.innerHTML = "";
  const cached = await invoke<DesignDoc | null>("cached_design", {
    path: s.path,
    lang,
  });
  if (selected?.path !== s.path || currentView !== "design") return;
  if (cached && cached.levels && cached.levels.length > 0) {
    hasDesign = true;
    renderDesign(cached);
  } else {
    showDesignPrompt(s);
  }
  updateRegenButton();
}

function showDesignPrompt(s: SessionMeta) {
  designView.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "generate-prompt";
  wrap.innerHTML = `
    <p>No layered design view generated yet.</p>
    <button class="generate-btn">✦ Generate Design Levels</button>
    <p class="hint">Blueprint breaks the document into High-level → Detailed →
      Implementation, strictly from what the document actually says.</p>`;
  wrap.querySelector(".generate-btn")!.addEventListener("click", () =>
    loadDesign(s, false),
  );
  designView.appendChild(wrap);
}

async function loadDesign(s: SessionMeta, force: boolean) {
  setStatus("");
  const stop = renderLoading(
    designView,
    force ? "Regenerating design levels…" : "Building design levels…",
  );
  try {
    const doc = await invoke<DesignDoc>("generate_design", {
      path: s.path,
      force,
      model,
      lang,
    });
    stop();
    if (selected?.path !== s.path) return;
    hasDesign = true;
    updateRegenButton();
    renderDesign(doc);
  } catch (e) {
    stop();
    if (selected?.path !== s.path) return;
    designView.innerHTML = "";
    setStatus(String(e), "error");
  }
}

function renderDesign(doc: DesignDoc) {
  designView.innerHTML = "";
  if (!doc.levels || doc.levels.length === 0) {
    designView.innerHTML = `<p class="muted">No design levels were produced.</p>`;
    return;
  }
  doc.levels.forEach((lvl, i) => {
    const card = document.createElement("section");
    card.className = "level-card" + (i === 0 ? " open" : "");
    const header = document.createElement("button");
    header.className = "level-head";
    header.innerHTML = `
      <span class="level-badge level-${i}">${escapeHtml(lvl.level)}</span>
      <span class="level-title">${escapeHtml(lvl.title)}</span>
      <span class="level-caret">▾</span>`;
    const bodyEl = document.createElement("div");
    bodyEl.className = "level-body";
    bodyEl.innerHTML = marked.parse(lvl.content || "") as string;
    header.addEventListener("click", () => card.classList.toggle("open"));
    card.appendChild(header);
    card.appendChild(bodyEl);
    designView.appendChild(card);
  });
}

// ---------- Glossary (Terms) ----------

async function showTermsOrPrompt(s: SessionMeta) {
  termsLoadedForPath = s.path;
  setStatus("");
  termsView.innerHTML = "";
  const cached = await invoke<GlossarySet | null>("cached_glossary", {
    path: s.path,
    lang,
  });
  if (selected?.path !== s.path || currentView !== "terms") return;
  if (cached && cached.terms && cached.terms.length > 0) {
    hasGlossary = true;
    renderGlossary(cached);
  } else {
    showGlossaryPrompt(s);
  }
  updateRegenButton();
}

function showGlossaryPrompt(s: SessionMeta) {
  termsView.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "generate-prompt";
  wrap.innerHTML = `
    <p>No glossary generated for this session yet.</p>
    <button class="generate-btn">✦ Generate Glossary</button>
    <p class="hint">Blueprint asks your local Claude Code to collect the technical
      terms from this session and explain each one in context. Cached after first run.</p>`;
  wrap.querySelector(".generate-btn")!.addEventListener("click", () =>
    loadGlossary(s, false),
  );
  termsView.appendChild(wrap);
}

async function loadGlossary(s: SessionMeta, force: boolean) {
  setStatus("");
  const stop = renderLoading(
    termsView,
    force ? "Regenerating glossary…" : "Building glossary…",
  );
  try {
    const set = await invoke<GlossarySet>("generate_glossary", {
      path: s.path,
      force,
      model,
      lang,
    });
    stop();
    if (selected?.path !== s.path) return;
    hasGlossary = true;
    updateRegenButton();
    renderGlossary(set);
  } catch (e) {
    stop();
    if (selected?.path !== s.path) return;
    termsView.innerHTML = "";
    setStatus(String(e), "error");
  }
}

function renderGlossary(set: GlossarySet) {
  termsView.innerHTML = "";
  if (!set.terms || set.terms.length === 0) {
    termsView.innerHTML = `<p class="muted">No terms were found for this session.</p>`;
    return;
  }
  for (const t of set.terms) {
    const card = document.createElement("div");
    card.className = "term-card";
    const cat = t.category
      ? `<span class="term-cat">${escapeHtml(t.category)}</span>`
      : "";
    card.innerHTML = `
      <div class="term-head"><span class="term-name">${escapeHtml(t.term)}</span>${cat}</div>
      <p class="term-def">${escapeHtml(t.definition)}</p>`;
    termsView.appendChild(card);
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
  const url = $<HTMLInputElement>("#import-url").value.trim();
  const status = $("#import-status");
  if (!url) return;
  status.textContent = "Fetching via Claude Code… (can take a moment)";
  try {
    const meta = await invoke<SessionMeta>("import_link", { url });
    status.textContent = "";
    $("#import-modal").classList.add("hidden");
    $<HTMLInputElement>("#import-url").value = "";
    await refreshSessions();
    selectSession(meta);
  } catch (e) {
    status.textContent = String(e);
  }
}

function wireUi() {
  filterInput.addEventListener("input", renderSessionList);
  $("#refresh-btn").addEventListener("click", refreshSessions);
  $("#regen-btn").addEventListener("click", () => {
    if (!selected) return;
    if (currentView === "terms") loadGlossary(selected, true);
    else if (currentView === "design") loadDesign(selected, true);
    else loadDiagrams(selected, true);
  });
  $("#update-btn").addEventListener("click", () => checkForUpdates(true));
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
    });
  });

  // Settings modal
  $("#settings-btn").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", () =>
    $("#settings-modal").classList.add("hidden"),
  );

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
      $("#settings-modal").classList.add("hidden");
      $("#notion-modal").classList.add("hidden");
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

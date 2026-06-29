import { invoke } from "@tauri-apps/api/core";
import mermaid from "mermaid";

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

type DepStatus = {
  claude: boolean;
  python: boolean;
  graphviz: boolean;
  diagrams_pkg: boolean;
};

let sessions: SessionMeta[] = [];
let selected: SessionMeta | null = null;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const sessionList = $("#session-list");
const filterInput = $<HTMLInputElement>("#filter-input");
const emptyState = $("#empty-state");
const viewer = $("#viewer");
const viewerTitle = $("#viewer-title");
const viewerSub = $("#viewer-sub");
const statusBar = $("#status-bar");
const diagramsView = $("#diagrams-view");
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
    const groupEl = document.createElement("div");
    groupEl.className = "session-group";
    groupEl.innerHTML = `<div class="group-label">${escapeHtml(project)}</div>`;
    for (const s of items) {
      const item = document.createElement("button");
      item.className =
        "session-item" + (selected?.path === s.path ? " active" : "");
      item.innerHTML = `
        <span class="session-title">${escapeHtml(s.title)}</span>
        <span class="session-meta">${fmtDate(s.modified)} · ${s.message_count} msgs</span>`;
      item.addEventListener("click", () => selectSession(s));
      groupEl.appendChild(item);
    }
    sessionList.appendChild(groupEl);
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function setStatus(msg: string, kind: "info" | "error" | "" = "info") {
  if (!msg) {
    statusBar.classList.add("hidden");
    return;
  }
  statusBar.textContent = msg;
  statusBar.className = `status-bar ${kind}`;
}

async function selectSession(s: SessionMeta) {
  selected = s;
  renderSessionList();
  emptyState.classList.add("hidden");
  viewer.classList.remove("hidden");
  viewerTitle.textContent = s.title;
  viewerSub.textContent = `${s.project} · ${fmtDate(s.modified)}`;
  switchView("diagrams");
  transcriptView.textContent = "Loading transcript…";
  await loadDiagrams(s, false);
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

async function loadDiagrams(s: SessionMeta, force: boolean) {
  setStatus(
    force
      ? "Regenerating diagrams via Claude Code…"
      : "Generating diagrams via Claude Code… (first run can take ~30s)",
    "info",
  );
  diagramsView.innerHTML = "";
  try {
    const set = await invoke<DiagramSet>("generate_diagrams", {
      path: s.path,
      force,
    });
    if (selected?.path !== s.path) return; // user switched away
    setStatus("");
    await renderDiagrams(set);
  } catch (e) {
    if (selected?.path !== s.path) return;
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
      <button class="src-toggle">&lt;/&gt; source</button>`;
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

    if (d.unavailable) {
      body.innerHTML = `<div class="unavailable">⚠︎ ${escapeHtml(d.unavailable)}</div>`;
    } else if (d.kind === "mermaid") {
      try {
        const { svg } = await mermaid.render(`mmd-${i}-${Date.now()}`, d.source);
        body.innerHTML = svg;
      } catch (e) {
        body.innerHTML = `<div class="unavailable">Mermaid render failed: ${escapeHtml(
          String(e),
        )}</div>`;
        src.classList.remove("hidden");
      }
    } else if (d.kind === "mingrammer" && d.rendered) {
      body.innerHTML = d.rendered;
    } else {
      body.innerHTML = `<div class="unavailable">Nothing to render.</div>`;
    }
  }
}

function switchView(view: "diagrams" | "transcript") {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.view === view);
  });
  diagramsView.classList.toggle("hidden", view !== "diagrams");
  transcriptView.classList.toggle("hidden", view !== "transcript");
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

function wireUi() {
  filterInput.addEventListener("input", renderSessionList);
  $("#refresh-btn").addEventListener("click", refreshSessions);
  $("#regen-btn").addEventListener("click", () => {
    if (selected) loadDiagrams(selected, true);
  });
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () =>
      switchView((t as HTMLElement).dataset.view as "diagrams" | "transcript"),
    );
  });
}

window.addEventListener("DOMContentLoaded", () => {
  wireUi();
  refreshSessions();
  refreshDeps();
});

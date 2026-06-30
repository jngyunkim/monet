# Monet

Walk through Claude Code design/architecture sessions — and external design
docs — level by level, with inline diagrams, hover-to-define terms, and a
follow-up Q&A.

Pick a source and Monet asks your **local** Claude Code CLI (`claude -p`,
headless) to explain it, **one level at a time, on demand**:

- **Design** — the document at **High-level → Detailed → Implementation**, each
  level generated independently. A level brings its own inline diagrams
  (`mermaid`, or `mingrammer/diagrams` for cloud/infra topology) and highlights
  its key terms — hover any term for an in-context definition. Strictly grounded
  in what the document says (it won't invent specifics).
- **Ask** — a multi-turn Q&A that answers follow-up questions using the source
  as context.

No API keys: it reuses your existing Claude Code authentication.

## How it works

```
Tauri app
  webview (UI)  <-- IPC -->  Rust backend
   · source list              · scan ~/.claude/projects, parse JSONL
   · per-level design          · resolve source text (session JSONL, or
   · mermaid + term anchors      link sources fetched via gh / Notion connector)
   · Ask thread                · claude -p per level / per question
   · transcript / source       · python3 + graphviz (mingrammer render)
                               · disk cache (keyed by source path + mtime + lang)
```

Each design level is a separate, cached `claude -p` call (prose + that level's
diagrams + terms), so you only generate what you want and each call stays small.
Generations are **cancellable** (the headless `claude` child is killed) and have
a hard timeout. Mermaid that fails to parse is sent back to `claude` once for an
automatic repair before falling back to showing the source.

## Requirements

- **Claude Code CLI** (`claude`) on PATH — required.
- **Graphviz + Python `diagrams`** — optional, only for mingrammer infra
  diagrams. Without them, mermaid still works; infra diagrams show a hint.
  - `brew install graphviz && pip install diagrams`

## Develop

```bash
npm install
npm run tauri dev
```

## Build a .app

```bash
npm run tauri build
# bundle: src-tauri/target/release/bundle/macos/
```

## Sources

- **Claude Code sessions** — scanned from `~/.claude/projects/*.jsonl`.
- **Links** — "Import from link" with one or more GitHub and/or Notion URLs
  (they can be mixed). Monet asks your local Claude Code to fetch them at
  generation time — GitHub via the `gh` CLI, Notion via the Claude Notion MCP
  connector. **No API keys.** The fetched content is viewable in the **Source**
  tab and cached as a local `.fetched.md`.

## Tabs

- **Design** — High-level → Detailed → Implementation, one level at a time. Each
  level has its own **Generate** button (→ **Regenerate** once cached, shared
  with the header button); generation can be **stopped**. Diagrams render inline
  (expand to a lightbox); key terms are underlined and show a definition on
  hover.
- **Ask** — multi-turn questions about the source.
- **Transcript / Source** — the extracted session transcript, or (for link
  sources) the fetched source content.

Each level is cached by source path + mtime, namespaced per level **and**
language.

## Settings

- **Language** (English / 한국어) — language of generated natural-language text.
- **Model** (header): Fast = Haiku, Balanced = Sonnet, Best = Opus.

## Layout

- `src-tauri/src/session.rs` — scan + JSONL parse + transcript extraction
- `src-tauri/src/imported.rs` — link sources: `.links.json` manifests, dynamic
  fetch (gh / Notion connector) → cached `.fetched.md`
- `src-tauri/src/level.rs` — per-level generation (prose + that level's diagrams
  + terms): prompt, parse, mingrammer render
- `src-tauri/src/ask.rs` — multi-turn Q&A over the source
- `src-tauri/src/diagram.rs` — `claude` invocation (cancellable + timeout),
  mermaid repair, mingrammer render, dep check
- `src-tauri/src/glossary.rs` — the `Term` type
- `src-tauri/src/cache.rs` — artifact cache (namespace + path + mtime key)
- `src-tauri/src/util.rs` — binary discovery, isolated work dir, language clause
- `src/main.ts` — UI

Generation uses a stripped headless `claude` (`--strict-mcp-config`,
`--setting-sources ""`, strict-JSON system prompt) for speed and reliable
parsing. Default model is `sonnet` (`DEFAULT_MODEL` in `lib.rs`). Spawned
`claude` runs in an isolated work dir to avoid macOS privacy prompts.

## Releases & in-app updates

The app self-updates via the Tauri updater, reading `latest.json` from the
GitHub Releases of `jngyunkim/blueprint`.

To cut a release:

```bash
# bump version in src-tauri/tauri.conf.json + package.json, then:
git tag v0.1.14 && git push origin v0.1.14
```

The `.github/workflows/release.yml` workflow builds on a macOS runner, signs the
update with the private key (repo secrets `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and publishes the `.dmg`, the updater
tarball + `.sig`, and `latest.json`. Running apps then see the update on launch
or via "Check for updates".

> The signing key lives at `~/.tauri/blueprint_updater.key` (keep it safe — it
> is **not** in the repo). The matching public key is in `tauri.conf.json`.

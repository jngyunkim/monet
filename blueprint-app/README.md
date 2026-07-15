# Monet

Walk through Claude Code design/architecture sessions — and external design
docs — as a forest and its trees, with inline diagrams, hover-to-define terms,
and a follow-up Q&A.

Pick a source and Monet asks your **local** Claude Code CLI (`claude -p`,
headless) to explain it as a **forest → trees**, on demand:

- **Design** — first the **forest**: a big-picture overview of the whole design,
  which also proposes the **trees** (the components/topics worth exploring).
  Pick any tree to drill into it full-screen — its own in-depth explanation,
  inline diagrams (`mermaid`, or `mingrammer/diagrams` for cloud/infra topology),
  and key terms you can hover for an in-context definition. Strictly grounded in
  what the document says (it won't invent specifics).
- **Ask** — a multi-turn Q&A that answers follow-up questions using the source
  as context.

No API keys: it reuses your existing Claude Code authentication.

## How it works

```
Tauri app
  webview (UI)  <-- IPC -->  Rust backend
   · source list              · scan ~/.claude/projects, parse JSONL
   · forest + tree design          · resolve source text (session JSONL, or
   · mermaid + term anchors      link sources fetched via gh / Notion connector)
   · Ask thread                · claude -p per forest/tree/question
   · transcript / source       · python3 + graphviz (mingrammer render)
                               · disk cache (keyed by source path + mtime + lang)
```

The forest and each tree are separate, cached `claude -p` calls (prose + that
view's diagrams + terms), so you only generate what you want and each call stays
small. Generations are **cancellable** (the headless `claude` child is killed)
and have a hard timeout. Mermaid that fails to parse is sent back to `claude`
once for an automatic repair before falling back to showing the source.

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

- **Design** — the **forest** (overview + a picker of trees), then drill into any
  **tree** full-screen. The forest and each tree have their own **Generate** /
  **Regenerate** (shared with the header button); generation can be **stopped**.
  Diagrams render inline (expand to a lightbox); key terms are underlined and
  show a definition on hover. Already-generated trees are marked in the picker.
- **Ask** — multi-turn questions about the source.
- **Transcript / Source** — the extracted session transcript, or (for link
  sources) the fetched source content.

The forest is cached by source path + mtime + language; each tree is cached by
its id as well.

## Settings

- **Language** (English / 한국어) — language of generated natural-language text.
- **Model** (header): Fast = Haiku, Balanced = Sonnet, Best = Opus.

## Layout

- `src-tauri/src/session.rs` — scan + JSONL parse + transcript extraction
- `src-tauri/src/imported.rs` — link sources: `.links.json` manifests, dynamic
  fetch (gh / Notion connector) → cached `.fetched.md`
- `src-tauri/src/forest.rs` — forest (overview + trees) and per-tree generation:
  prompts, parse, mingrammer render
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
GitHub Releases of `jngyunkim/monet`.

To cut a release:

```bash
# bump version in src-tauri/tauri.conf.json + package.json, then:
git tag v0.1.15 && git push origin v0.1.15
```

The `.github/workflows/release.yml` workflow builds on a macOS runner, signs the
update with the private key (repo secrets `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and publishes the `.dmg`, the updater
tarball + `.sig`, and `latest.json`. Running apps then see the update on launch
or via "Check for updates".

> The signing key lives at `~/.tauri/blueprint_updater.key` (keep it safe — it
> is **not** in the repo). The matching public key is in `tauri.conf.json`.

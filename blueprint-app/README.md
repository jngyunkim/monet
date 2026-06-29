# Blueprint

Visualize Claude Code design/architecture sessions as diagrams.

Pick a past Claude Code session and Blueprint asks your **local** Claude Code
CLI (`claude -p`, headless) to turn the design discussion into diagrams —
`mermaid` for flows/sequences/relationships, and `mingrammer/diagrams` for
cloud/infra topology when appropriate.

No API keys: it reuses your existing Claude Code authentication.

## How it works

```
Tauri app
  webview (UI)  <-- IPC -->  Rust backend
   · session list             · scan ~/.claude/projects, parse JSONL
   · mermaid rendering         · extract clean transcript (drops tool noise)
   · infra SVG display         · claude -p  (diagram generation)
   · transcript / source       · python3 + graphviz (mingrammer render)
                               · disk cache (keyed by session path + mtime)
```

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

## Layout

- `src-tauri/src/session.rs` — scan + JSONL parse + transcript extraction
- `src-tauri/src/diagram.rs` — claude invocation, JSON parse, mingrammer render
- `src-tauri/src/cache.rs` — diagram cache (path + mtime key)
- `src-tauri/src/util.rs` — binary resolution for GUI-launched PATH
- `src/main.ts` — UI: session list, diagram rendering, transcript view

The default model is `sonnet` (see `DEFAULT_MODEL` in `lib.rs`).

## Releases & in-app updates

The app self-updates via the Tauri updater, reading `latest.json` from the
GitHub Releases of `jngyunkim/blueprint`.

To cut a release:

```bash
# bump version in src-tauri/tauri.conf.json + package.json, then:
git tag v0.1.1 && git push origin v0.1.1
```

The `.github/workflows/release.yml` workflow builds on a macOS runner, signs the
update with the private key (repo secrets `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and publishes the `.dmg`, the updater
tarball + `.sig`, and `latest.json`. Running apps then see the update on launch
or via "Check for updates".

> The signing key lives at `~/.tauri/blueprint_updater.key` (keep it safe — it
> is **not** in the repo). The matching public key is in `tauri.conf.json`.


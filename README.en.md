# Herdr Desktop

> A multi-agent management desktop app — the runtime your coding agents live on.
>

**English** | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build & Release](https://github.com/zdfdonny/herdr-desktop/actions/workflows/release.yml/badge.svg)](https://github.com/zdfdonny/herdr-desktop/actions/workflows/release.yml)
[![Electron](https://img.shields.io/badge/Electron-44-47848F.svg)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#download)

---

## Screenshot

![Herdr Desktop interface](docs/screenshot.png)

Projects and agents on the left (with branch badges and status dots), several agent
terminals side by side on the right. The screenshot shows 5 agents running at once
in working / done / idle / waiting-for-input states, with the in-app status
notification in the bottom-right corner.

---

## What is this

Herdr Desktop turns "running several AI coding agents in terminals at once" from a
pile of frantic terminal windows into an actual desktop application: projects and
agents on the left, each agent's terminal side by side on the right, with status
visible at a glance.

It takes its design cues from [herdr](https://github.com/herdrdev/herdr) (a Rust
terminal multi-agent runtime). herdr itself is **a pure terminal TUI program** and
ships no desktop app; this project is a separate desktop client built outside of
herdr, implementing its own agent runtime backend so that agent status, layout, and
session management become first-class GUI data rather than ASCII art in a terminal.

### How it differs from "wrapping herdr in a terminal"

The most direct way to give herdr a graphical interface is a **pure terminal
passthrough shell**: the Electron main process runs `herdr.exe` as a child process
via `node-pty` and pipes the whole TUI through to a single xterm.js — the window
still shows herdr's character-based interface.

Herdr Desktop does not take that shortcut: it does **not depend on the herdr
binary** at all. It owns the PTY lifecycle, status detection, and persistence, and
manages the agent processes directly.

| | Terminal passthrough shell | Herdr Desktop |
|---|---|---|
| What runs | the herdr TUI | the agent processes themselves |
| Where the UI comes from | herdr's ASCII interface | native React components |
| Agent status | parsed from screen contents | structured state from the runtime backend |
| Dependency | requires the herdr binary | none |

---

## Features

### Terminal

- **xterm.js 6 + WebGL rendering** — stays smooth under heavy output
- **node-pty** — ConPTY on Windows, forkpty on macOS / Linux
- **Two-phase pane creation** — create pane → mount terminal and fit → spawn PTY
  with exact `cols/rows`. Fully resolves first-frame layout corruption in TUI apps
  like opencode
- **Terminal background follows the theme** (VSCode `terminal.background` style);
  the WebGL addon is rebuilt on theme switch
- **Adjustable font size** (9–24px) and scrollback search

### Agent management

- **Project → Agent two-level model** — add a project directory, then create agents
  inside it
- **24 built-in agent presets** — Claude Code, Codex, Gemini CLI, Cursor Agent,
  OpenCode, GitHub Copilot CLI, Qwen Code, Kimi, Kiro, Droid, Amp, Grok, Cline,
  MastraCode, Letta, Muse, and more, plus a plain terminal
- **Availability probing** — filters by what actually resolves on your PATH, so
  only agents you have installed are shown
- **Status badges** — idle / working / blocked / done
- **Status change notifications** — toast on blocked / done, plus a native system
  notification when blocked while the window is unfocused
- **Side-by-side panes** — horizontal split, each pane an independent xterm
  instance with no cross-talk

### Sessions and recovery

- **Atomic persistence** — serialized write chain + unique temp filenames + rename,
  so concurrent writes never conflict
- **Restore on reopen** — projects / panes / agents are restored at startup, but
  processes are **not** auto-spawned; they start on demand when you click an agent
  row (no thundering herd at launch)
- **Failures keep your structure** — if a command was uninstalled, the pane entry
  is retained and you can retry by clicking it again

### Interface

- **split style layout** with a custom title bar (native window buttons kept)
- **Light / dark / follow-system** themes
- **Chinese and English UI**, Chinese by default

---

## Download

Grab the installer for your platform from [Releases](../../releases):

| Platform | Arch | File |
|----------|------|------|
| Windows | x64 | `herdr-desktop-*-win-x64-setup.exe` |
| Windows | arm64 | `herdr-desktop-*-win-arm64-setup.exe` |
| macOS | Intel | `herdr-desktop-*-mac-x64.dmg` |
| macOS | Apple Silicon | `herdr-desktop-*-mac-arm64.dmg` |
| Linux | x64 | `herdr-desktop-*-linux-x64.AppImage` / `.deb` |
| Linux | arm64 | `herdr-desktop-*-linux-arm64.AppImage` / `.deb` |

Every release includes a `SHA256SUMS.txt`.

> **macOS users**: the app is **not code-signed or notarized**. On first launch,
> right-click → Open, or run:
>
> ```bash
> xattr -cr "/Applications/Herdr.app"
> ```
>
> **Linux users**: make the AppImage executable first:
>
> ```bash
> chmod +x "herdr-desktop-*-linux-x64.AppImage"
> ```

---

## Getting started

### Requirements

- **Node.js 20+**
- Windows / macOS / Linux

### Run from source

```bash
git clone https://github.com/zdfdonny/herdr-desktop.git
cd herdr-desktop
npm install
npm run dev
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development mode with hot reload |
| `npm run build` | Build to `dist/` and `dist-electron/` |
| `npm run typecheck` | TypeScript type check |
| `npm run test:unix` | Unit tests for the Unix platform layer |
| `npm run icon` | Regenerate the app icon |
| `npm run dist:win` | Package for Windows |
| `npm run dist:mac` | Package for macOS |
| `npm run dist:linux` | Package for Linux |

For a specific architecture use `dist:win:x64` / `dist:win:arm64` /
`dist:mac:x64` / `dist:mac:arm64` / `dist:linux:x64` / `dist:linux:arm64`.

### Workflow

1. Click **Add Project** on the left and pick a local code directory
2. Click **+** under the project and choose an agent (only installed ones appear)
3. The agent's terminal shows up on the right; the sidebar status dot tracks it
4. Closing the window does **not** kill agents — reopen and click the agent to
   return to its session

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Main process (Node)               │
│  Agent runtime backend: PTY lifecycle / detection /  │
│  persistence                                        │
└───────────────────────┬─────────────────────────────┘
                        │  Versioned IPC contract
                        │  { type, version, payload }
                        │  Dual channel: pty:data (high-freq)
                        │                state (structural)
┌───────────────────────┴─────────────────────────────┐
│                 Renderer process (React)            │
│  Project/agent list · status badges · split layout · │
│  xterm.js                                           │
└─────────────────────────────────────────────────────┘
```

### Core design principles

- **State / Runtime separation** — `shared/state.ts` is plain serializable data;
  `PtyRuntime` lives only in the main process and is never serialized
- **Unidirectional data flow** — the renderer store is a projection of main-process
  state; there is no local authoritative state
- **Versioned frozen contract** — a single envelope; breaking changes must bump the
  version
- **Dual-channel separation** — high-frequency terminal data never interferes with
  low-frequency structural state
- **Platform isolation** — all platform differences live in `electron/platform/`;
  core modules contain zero platform branching

### Project layout

```
herdr-desktop/
├── electron/              # Main process
│   ├── runtime/           #   PTY manager / detection / session / persistence
│   ├── ipc/               #   IPC contract and routing
│   └── platform/          #   Platform layer (win / unix / darwin / linux)
├── src/                   # Renderer process (React)
│   ├── components/        #   Flat components
│   ├── stores/            #   Zustand
│   └── xterm/             #   xterm.js wrapper
├── shared/                # Types shared across all three processes
├── scripts/               # Icon generation / verification / tests
└── docs/                  # Architecture and status docs
```

See [`docs/architecture.md`](docs/architecture.md) for the full design and
[`docs/status.md`](docs/status.md) for implementation progress.

### Platform differences

All platform differences are confined to `electron/platform/`, dispatched on
`process.platform`:

| Concern | Windows | macOS / Linux |
|---------|---------|---------------|
| Command resolution | PATH × PATHEXT, extension appended | PATH scan, **executable bit** is the signal |
| Launch wrapping | `.cmd`/`.bat` need `cmd.exe /d /c` | Not applicable |
| Launch environment | Inherited directly | Harvested via `shell -l -i -c env` |
| Terminal backend | ConPTY | forkpty |
| Terminal shortcuts | `Ctrl+Shift+C/V`, `Ctrl+F` | `⌘C` / `⌘V` / `⌘F` |

> GUI apps launched from Finder / `.desktop` do **not** inherit your shell's PATH,
> so macOS and Linux must actively harvest the login environment — otherwise
> already-installed agents get misreported as "not installed".

---

## Contributing

Issues and pull requests are welcome.

```bash
git checkout -b feature/your-feature
# make your changes
npm run typecheck && npm run test:unix
git commit -m "feat: ..."
git push origin feature/your-feature
```

Please make sure `npm run typecheck` passes before submitting — the project uses
TypeScript strict mode, including `noUnusedLocals` / `noUnusedParameters`.

---

## Building and releasing

Releases run through GitHub Actions and are **manually triggered**:

`Actions` → `Build & Release` → `Run workflow`

- The version defaults to `package.json`'s `version`; you can override the tag
- Builds **3 platforms × 2 architectures = 6 installers** and publishes them to a
  Release
- Optionally publish as a draft so you can inspect artifacts first

> **Known limitation**: the macOS and Linux code paths are complete but **have not
> been verified on real hardware**. See [`docs/status.md`](docs/status.md).

---

## Acknowledgements

- [herdr](https://github.com/herdrdev/herdr) — the design inspiration
- [xterm.js](https://xtermjs.org/) / [node-pty](https://github.com/microsoft/node-pty)
- [Electron](https://www.electronjs.org/) / [React](https://react.dev/) / [Zustand](https://zustand-demo.pmnd.rs/)

## License

[MIT](LICENSE)

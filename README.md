# CE Host

The qBittorrent-for-compute hosting dashboard. Open it, see what's running, see what
you earn, set caps, walk away.

CE Host is a **pure SDK client** — zero new node primitives. It talks to a local CE
node's existing HTTP+SSE API via [`@ce-net/sdk`](../ce-ts) and renders:

- **Overview header** — earnings, share ratio badge, bond/weight, uptime, jobs running,
  up-compute, live credits/min (`/status` + `/history/:self` + `/transactions/stream`).
- **Running jobs** — a live, torrent-style table with per-row image, payer, cpu/mem,
  elapsed, status, credits/min and a **kill** button (`/jobs`, `DELETE /jobs/:id`).
- **Resource caps + scheduler** — CPU/mem offered, max jobs, advisory throttle, and a
  window/battery/CPU scheduler.
- **Mesh atlas** — peers, capacity and tags with self highlighted (`/atlas`).
- **Capabilities** — a local issued-grant log with copy/revoke, plus the on-chain
  revoked set (`/capabilities/revoked`, `POST /capabilities/revoke`).

## Run (pure web)

```bash
npm install
npm run dev      # http://localhost:5180, proxies /ce → 127.0.0.1:8844
```

Start a local node first (`ce start`). Read panels work without a token; mutating
actions (kill, revoke) need one — paste `CE_API_TOKEN` into the read-only banner, or run
behind a same-origin authenticated proxy.

```bash
npm run build    # tsc --noEmit typecheck + vite production build → dist/
```

## Architecture

Framework-free TypeScript + Vite. A single reactive `Store` (`src/stores/store.ts`) owns
all polling and the two SSE streams, derives the per-job credit accrual from the
transaction stream, and fans changes out to panels in `src/panels/`. Money is an
`Amount` (bigint base units, 10^18/credit) end to end — never a float, never a `number`.

### The graceful-drain pause (important)

The "Pause hosting now" control is **not** a node restart. Pausing forfeits uptime
rewards and risks job-expiry against your history, so the control:

1. surfaces that economic cost explicitly,
2. performs a **graceful drain** — stops accepting *new* work while leaving running
   jobs to finish so you still get paid for them, then transitions to paused,
3. never issues a `ce stop` that would kill in-flight hosted jobs.

In the web tier "stop accepting new work" is expressed by advertising zero capacity; the
Tauri supervisor performs the equivalent real drain.

## Tauri desktop shell (`src-tauri/`)

The same web bundle wraps unchanged in a Tauri v2 window. The Rust `src-tauri` side adds
the three things a browser cannot do — and the web build stays a complete fallback when
the shell is absent (`isTauri()` is false → every native call degrades to a no-op).

1. **Lifecycle supervision** (`src-tauri/src/supervisor.rs`) — detect/install `ce`, run
   `ce start`, poll `GET /health`, and a system tray (show / pause / resume / quit) so a
   non-technical user never types a command. Closing the window hides to the tray; the
   node keeps earning.
2. **Token off disk** — read `~/.local/share/ce/api.token` (chmod 600, via
   `dirs::data_dir()`) and hand it to the web UI over the `read_token` / `node_status`
   IPC commands; the read-only banner disappears and authed calls (kill / revoke / name
   claim) just work.
3. **Graceful-drain pause** — `pause_hosting` / `resume_hosting` IPC commands restart the
   node into a `--no-mine` posture (stop accepting/advertising new work) while leaving
   running jobs to finish. This is **never** a `ce kill` (see the drain note above).

The front-end seam is the single file `src/lib/tauri.ts`: it lazily, dynamically imports
`@tauri-apps/api` only inside the native shell, so the pure-web bundle never hard-depends
on Tauri at load time. The 4-step onboarding wizard (`src/panels/onboarding.ts`) drives
these commands in native mode and collapses to "point me at a node" on the web.

### Build the shell

```bash
# Rust shell (compiles against the Vite `dist/` produced by `npm run build`)
cd src-tauri
cargo build            # debug shell
cargo test             # supervisor state-machine + serde-shape unit tests

# Full desktop bundle (requires the tauri CLI: `cargo install tauri-cli --version ^2`)
cargo tauri build      # runs `npm run build` then bundles per `tauri.conf.json`
cargo tauri dev        # runs `npm run dev` (:5180) inside the native window
```

`main.ts` is deliberately framework-free to make the wrap trivial. See `docs/design.md`.

### Onboarding (4 steps)

Shown on first run (gated by `localStorage` key `ce-host.onboarded.v1`):
**Install** (detect / one-click install `ce`) → **Start** (`ce start`, wait for health,
read api.token) → **Name** (optional `POST /names/claim` via the SDK) → **Caps** (sliders
default to ~50% cores / RAM, "Always host"). On the web build steps 1–2 become a
base-URL + optional-token connect form; the wizard still produces a configured dashboard.

## Honest gaps (TODO)

- `/jobs` rows carry no live cpu/mem/elapsed/credits-min. Elapsed is derived from a
  local `first_seen_at`; credits/min from a best-effort transaction-stream join; per-job
  requested cpu/mem renders `—` for jobs hosted for others. The optional read-only node
  endpoint `GET /jobs/:id/live` (design §9) makes these exact — wire it when it lands.
- The image string is not on the `/jobs` row for jobs hosted for others; we show the
  short container/job id as a stable identifier until `/jobs/:id/live` exists.
- Issuing a real capability needs the node's signing key (the `ce grant` CLI / the Tauri
  supervisor). The web "record grant" flow logs a grant created out of band; the Tauri
  shell will wire a real issue button. Marked `TODO(tauri)`.

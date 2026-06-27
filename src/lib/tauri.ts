/**
 * Tauri bridge — the single seam between the pure-web bundle and the native shell.
 *
 * The exact same front-end bundle ships two ways:
 *   - Pure web (fallback): no Tauri runtime present. `isTauri()` is false, every
 *     command here resolves to a benign "unsupported" result, and the UI falls back to
 *     the BYO-token / read-only path. Nothing in the web build depends on Tauri at load
 *     time — the `@tauri-apps/api` import is dynamic and lazily attempted, so a browser
 *     that has never heard of Tauri loads and runs fine.
 *   - Native (Tauri): the `__TAURI_INTERNALS__` global is injected by the shell. We then
 *     `invoke()` Rust commands defined in `src-tauri/src/lib.rs` to detect/start the local
 *     `ce` node, read its api.token off disk (a chmod-600 file the browser cannot read),
 *     and perform the graceful-drain pause/resume.
 *
 * Money discipline: no amounts cross this bridge. The node lifecycle is plain state;
 * all credit values stay in the SDK's `Amount` (base-unit BigInt) on the HTTP path.
 */

/** Node lifecycle state reported by the Rust supervisor. */
export type NodeRunState = "absent" | "stopped" | "starting" | "running" | "draining";

/** Result of probing for the `ce` binary on the host. */
export interface CeInstall {
  /** True if a `ce` binary was found on PATH or in a known install dir. */
  installed: boolean;
  /** Absolute path to the binary if found. */
  path?: string;
  /** `ce --version` output, when resolvable. */
  version?: string;
}

/** Snapshot of the supervised node. */
export interface NodeSnapshot {
  state: NodeRunState;
  /** True once `GET /health` returns ok. */
  healthy: boolean;
  /** Base URL the node serves its HTTP API on. */
  baseUrl: string;
  /** API token read from the data dir, if available (native only). */
  token?: string;
  /** Process id of the supervised node, if we started it. */
  pid?: number;
  /** Human-readable note (e.g. last error) for the UI. */
  note?: string;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeCache: InvokeFn | null | undefined;

/** True when running inside the Tauri native shell. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Lazily resolve Tauri's `invoke`. Returns null in the pure-web build (or if the API
 * package is not bundled), so callers degrade gracefully without throwing at import time.
 */
async function getInvoke(): Promise<InvokeFn | null> {
  if (invokeCache !== undefined) return invokeCache;
  if (!isTauri()) {
    invokeCache = null;
    return null;
  }
  try {
    // Dynamic, so the web bundle never hard-requires @tauri-apps/api at parse time.
    const mod = (await import(
      /* @vite-ignore */ "@tauri-apps/api/core"
    )) as { invoke: InvokeFn };
    invokeCache = mod.invoke;
    return invokeCache;
  } catch {
    invokeCache = null;
    return null;
  }
}

const ABSENT: NodeSnapshot = {
  state: "stopped",
  healthy: false,
  baseUrl: "/ce",
  note: "Tauri shell unavailable (web mode).",
};

/** Which native shell this is: desktop supervises a node; mobile runs as a companion. */
export type ShellPlatform = "desktop" | "ios" | "android" | "web";

/**
 * Resolve the shell platform. `web` when not in Tauri at all. On mobile (ios/android) the
 * sandbox cannot install or spawn `ce`, so the host seam runs in companion mode instead of
 * supervising a local node.
 */
export async function shellPlatform(): Promise<ShellPlatform> {
  const invoke = await getInvoke();
  if (!invoke) return "web";
  try {
    return await invoke<ShellPlatform>("platform");
  } catch {
    return "web";
  }
}

/** Probe for an installed `ce` binary. Web mode reports "not installed, unknown". */
export async function detectCe(): Promise<CeInstall> {
  const invoke = await getInvoke();
  if (!invoke) return { installed: false };
  try {
    return await invoke<CeInstall>("detect_ce");
  } catch {
    return { installed: false };
  }
}

/**
 * Ask the supervisor to start `ce start` and wait until `GET /health` is ok (bounded).
 * Returns the resulting snapshot (including the api.token read off disk).
 */
export async function startNode(): Promise<NodeSnapshot> {
  const invoke = await getInvoke();
  if (!invoke) return ABSENT;
  return invoke<NodeSnapshot>("start_node");
}

/** Current supervised-node snapshot. Web mode returns a stopped placeholder. */
export async function nodeStatus(): Promise<NodeSnapshot> {
  const invoke = await getInvoke();
  if (!invoke) return ABSENT;
  try {
    return await invoke<NodeSnapshot>("node_status");
  } catch {
    return ABSENT;
  }
}

/** Read the node's api.token from the data dir (chmod-600, native only). */
export async function readToken(): Promise<string | undefined> {
  const invoke = await getInvoke();
  if (!invoke) return undefined;
  try {
    const tok = await invoke<string | null>("read_token");
    return tok ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Graceful-drain pause. This is NOT a node kill. The supervisor stops the node from
 * accepting/advertising new work, leaves running jobs to finish, then idles. The Rust
 * side enforces this honestly (see src-tauri); web mode returns the unsupported snapshot
 * so the caller falls back to the in-app drain-intent behavior.
 */
export async function pauseHosting(): Promise<NodeSnapshot> {
  const invoke = await getInvoke();
  if (!invoke) return { ...ABSENT, state: "draining", note: "web drain (advertise nothing)" };
  return invoke<NodeSnapshot>("pause_hosting");
}

/** Resume hosting after a graceful drain. */
export async function resumeHosting(): Promise<NodeSnapshot> {
  const invoke = await getInvoke();
  if (!invoke) return ABSENT;
  return invoke<NodeSnapshot>("resume_hosting");
}

/**
 * Run the platform installer for `ce` (brew / install.sh / scoop) via the supervisor.
 * Returns the post-install detection result. Web mode is a no-op (no host access).
 */
export async function installCe(): Promise<CeInstall> {
  const invoke = await getInvoke();
  if (!invoke) return { installed: false };
  return invoke<CeInstall>("install_ce");
}

// ---- ce-appmgr (the `ce app` substrate) ----
//
// `ce app` is compiled into the `ce` binary, so a working `ce` install already carries
// the app manager. These commands let the Apps view list/install/run ceapps through the
// supervisor, which shells out to `ce app …`. The node stays primitives-only; this is app
// lifecycle policy living in the shell. Web mode degrades to "desktop app required".

/** Readiness of the `ce app` substrate (i.e. `ce app list` runs cleanly). */
export interface AppmgrStatus {
  ready: boolean;
  note?: string;
}

/** Result of a `ce app install` run: success flag + combined stdout/stderr tail. */
export interface AppCmdResult {
  ok: boolean;
  output: string;
}

/** Probe whether the app manager is usable (the `ce` binary is present and `ce app` works). */
export async function appmgrStatus(): Promise<AppmgrStatus> {
  const invoke = await getInvoke();
  if (!invoke) return { ready: false, note: "Web build — install the CE Desktop app to manage apps." };
  try {
    return await invoke<AppmgrStatus>("appmgr_status");
  } catch (e) {
    return { ready: false, note: e instanceof Error ? e.message : String(e) };
  }
}

/** Raw `ce app list` stdout (locally installed apps). Empty string in web mode. */
export async function ceAppListRaw(): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) return "";
  try {
    return await invoke<string>("app_list_raw");
  } catch {
    return "";
  }
}

/** Raw `ce app ps` stdout (running instances across the mesh). Empty string in web mode. */
export async function ceAppPsRaw(): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) return "";
  try {
    return await invoke<string>("app_ps_raw");
  } catch {
    return "";
  }
}

/** Install a ceapp by name via `ce app install <name>`. Web mode reports unavailable. */
export async function ceAppInstall(name: string): Promise<AppCmdResult> {
  const invoke = await getInvoke();
  if (!invoke) return { ok: false, output: "Desktop app required to install apps." };
  return invoke<AppCmdResult>("app_install", { name });
}

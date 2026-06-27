/**
 * Host seam — "where is my node", resolved once per platform shell.
 *
 * CE Desktop ships one bundle across three shells (PLAN/native-ui-flagship.md); each reaches
 * a node a different way, and this is the single place that difference lives:
 *
 *   - **tauri**  — the Tauri supervisor runs a local `ce` node; we adopt its base URL + the
 *                  api.token read off disk (a chmod-600 file the browser cannot read).
 *   - **bridge** — a browser PWA where the page is itself a node: `window.__ceNode` (injected by
 *                  ce-serve's /mesh-bridge or an in-tab WASM node). We route through the SDK's
 *                  in-process `bridgeFetch` — no network, no token, confined by one strict CSP.
 *   - **proxy**  — a browser served same-origin behind a reverse proxy at `/ce` → 127.0.0.1:8844.
 *   - **byo**    — a plain browser pointed at a node by URL, with an optional pasted token.
 *
 * The panels never learn which: they consume the Store, and the Store is reconfigured from the
 * binding this returns. Only `proxy`/`byo` may need a token for mutating calls (`needsToken`).
 */

import {
  bridgeFetch,
  getBridge,
  BRIDGE_BASE_URL,
  SAME_ORIGIN_NODE_PATH,
} from "@ce-net/sdk";
import { isTauri, nodeStatus, readToken, shellPlatform } from "./tauri.js";
import { loadConfig } from "./config.js";

export type HostKind = "tauri" | "bridge" | "proxy" | "byo";

export interface HostBinding {
  kind: HostKind;
  baseUrl: string;
  token?: string;
  /** Injected fetch (the in-browser node bridge); absent for network transports. */
  fetch?: typeof fetch;
  /** Short human label for the rail/header. */
  label: string;
  /** True when mutating calls need a token the binding does not already carry. */
  needsToken: boolean;
}

/** Resolve the active node transport for this shell. Never throws — degrades to BYO. */
export async function resolveHost(): Promise<HostBinding> {
  // 1. Native DESKTOP only: adopt the supervised node + on-disk token. Mobile shells
  //    (ios/android) cannot install or spawn `ce`, so they fall through to companion mode
  //    (a paired/remote node), exactly like a browser.
  if (isTauri() && (await shellPlatform()) === "desktop") {
    try {
      const snap = await nodeStatus();
      const token = snap.token ?? (await readToken());
      const baseUrl = snap.baseUrl || loadConfig().baseUrl;
      return bind("tauri", baseUrl, "local node", false, token);
    } catch {
      const cfg = loadConfig();
      return bind("byo", cfg.baseUrl, "local node", !cfg.token, cfg.token);
    }
  }

  // 2. Browser PWA with an in-page node bridge: route in-process, no token needed.
  const bridge = getBridge();
  if (bridge) {
    return {
      kind: "bridge",
      baseUrl: BRIDGE_BASE_URL,
      fetch: bridgeFetch(bridge),
      label: "in-browser node",
      needsToken: false,
    };
  }

  // 3 + 4. Same-origin proxy, or an explicit BYO URL.
  const cfg = loadConfig();
  const isProxy = cfg.baseUrl === SAME_ORIGIN_NODE_PATH || cfg.baseUrl === "/ce";
  return bind(
    isProxy ? "proxy" : "byo",
    cfg.baseUrl,
    isProxy ? "proxy /ce" : cfg.baseUrl,
    !cfg.token,
    cfg.token,
  );
}

/** Build a binding, including `token` only when present (exactOptionalPropertyTypes). */
function bind(
  kind: HostKind,
  baseUrl: string,
  label: string,
  needsToken: boolean,
  token?: string,
): HostBinding {
  const b: HostBinding = { kind, baseUrl, label, needsToken };
  if (token) b.token = token;
  return b;
}

/** True when this shell already has a working node transport that needs no token paste. */
export function hostIsManaged(): boolean {
  return isTauri() || getBridge() !== null;
}

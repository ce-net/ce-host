/**
 * Apps view — the ce-appmgr store inside the desktop app.
 *
 * `ce app` is the ONE app substrate (it ships inside the `ce` binary). This view drives
 * it through the Tauri supervisor: install a curated set of ceapps with one click, and
 * read what is installed (`ce app list`) and what is running across the mesh (`ce app ps`).
 *
 * The CLI prints human text, not JSON, so installed/running are shown verbatim in a
 * monospace panel — honest and never misparsed. When the node grows a structured app
 * surface, these panels become cards (Phase 2/3) without changing the catalog or install
 * flow. In the pure-web build there is no host to install onto, so the view explains that
 * the desktop app is required and still lists the catalog for discovery.
 */

import { el, mount } from "../lib/dom.js";
import { toast } from "../lib/toast.js";
import {
  isTauri,
  appmgrStatus,
  ceAppInstall,
  ceAppListRaw,
  ceAppPsRaw,
  type AppmgrStatus,
} from "../lib/tauri.js";
import type { Store } from "../stores/store.js";

interface CatalogApp {
  name: string;
  title: string;
  desc: string;
}

/**
 * A starter catalog of small, useful ceapps. Names are the registry ids `ce app install`
 * understands. This is a curated list, not the full registry — the live ce-hub browse
 * lands in a later phase; until then these are the proven, install-with-one-click apps.
 */
const CATALOG: CatalogApp[] = [
  { name: "clip", title: "Clip", desc: "Ambient clipboard sync across your fleet — copy here, paste there." },
  { name: "rdev", title: "rdev", desc: "Remote dev over the mesh: exec, file sync, and long builds on another machine." },
  { name: "ce-expose", title: "ce-expose", desc: "ngrok-style TCP/HTTP tunnels over CE, capability-gated." },
  { name: "ce-drive", title: "ce-drive", desc: "Mesh Google-Drive: content-addressed, dedup, capability-shared." },
  { name: "ce-notes", title: "ce-notes", desc: "Local-first, end-to-end encrypted CRDT notes." },
  { name: "ce-chat", title: "ce-chat", desc: "Decentralized team chat over pubsub — channels, DMs, threads." },
  { name: "ce-explorer", title: "ce-explorer", desc: "Live read-only block/tx explorer + share-ratio leaderboard." },
  { name: "ce-cast-desktop", title: "ce-cast", desc: "Native live multicast studio (YouTube/Twitch/Kick/X)." },
];

// Module-level cache so navigating away and back does not refetch on every visit.
let cache: { list: string; ps: string; status: AppmgrStatus | null } = {
  list: "",
  ps: "",
  status: null,
};

export function renderApps(store: Store, root: HTMLElement): void {
  void store; // reserved for future per-app placement on this node
  const native = isTauri();

  const statusEl = el("div", {});
  const installedHost = el("div", {});
  const runningHost = el("div", {});

  const refresh = async () => {
    cache.status = await appmgrStatus();
    drawStatus(statusEl, cache.status, native);
    cache.list = await ceAppListRaw();
    drawTextCard(installedHost, "Installed apps", cache.list || "No apps installed yet.", refresh);
    cache.ps = await ceAppPsRaw();
    drawTextCard(runningHost, "Running instances", cache.ps || "No running instances.");
  };

  // Paint immediately from cache, then refresh live.
  drawStatus(statusEl, cache.status, native);
  drawTextCard(installedHost, "Installed apps", cache.list || "Loading…", refresh);
  drawTextCard(runningHost, "Running instances", cache.ps || "Loading…");

  mount(
    root,
    statusEl,
    catalogCard(native, refresh),
    el("div", { class: "explorer-grid" }, installedHost, runningHost),
  );

  void refresh();
}

function drawStatus(host: HTMLElement, status: AppmgrStatus | null, native: boolean): void {
  if (!native) {
    mount(
      host,
      el(
        "div",
        { class: "view", style: "padding:0 0 16px" },
        el(
          "div",
          { class: "token-banner" },
          el("span", {}, "Web build — install the CE Desktop app to install and run apps on this machine."),
        ),
      ),
    );
    return;
  }
  if (!status) {
    mount(host, el("div", {}));
    return;
  }
  const ok = status.ready;
  mount(
    host,
    el(
      "div",
      { class: "view", style: "padding:0 0 16px" },
      el(
        "div",
        { class: ok ? "warn-box ok-box" : "warn-box" },
        el("span", { class: ok ? "dot on" : "dot warn" }),
        ok
          ? "  App manager ready — ce app is available."
          : `  App manager unavailable. ${status.note ?? ""}`,
      ),
    ),
  );
}

function catalogCard(native: boolean, refresh: () => void | Promise<void>): HTMLElement {
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h2", {}, "App store"),
      el("div", { class: "right muted-note" }, `${CATALOG.length} apps`),
    ),
    el("div", { class: "apps-grid" }, ...CATALOG.map((a) => appCard(a, native, refresh))),
  );
}

function appCard(a: CatalogApp, native: boolean, refresh: () => void | Promise<void>): HTMLElement {
  const btn = el(
    "button",
    {
      class: "btn sm primary",
      onClick: async () => {
        if (!native) {
          toast("Open the CE Desktop app to install apps.", "warn");
          return;
        }
        btn.setAttribute("disabled", "");
        btn.textContent = "Installing…";
        toast(`Installing ${a.name}…`, "ok");
        try {
          const r = await ceAppInstall(a.name);
          if (r.ok) {
            toast(`${a.name} installed.`, "ok");
            void refresh();
          } else {
            toast(`Install failed: ${tail(r.output)}`, "err");
          }
        } catch (e) {
          toast(`Install failed: ${e instanceof Error ? e.message : String(e)}`, "err");
        } finally {
          btn.removeAttribute("disabled");
          btn.textContent = "Install";
        }
      },
    },
    "Install",
  );
  return el(
    "div",
    { class: "app-card" },
    el("div", { class: "app-name" }, a.title, el("span", { class: "app-id" }, a.name)),
    el("div", { class: "app-desc" }, a.desc),
    el("div", { class: "app-actions" }, btn),
  );
}

function drawTextCard(
  host: HTMLElement,
  title: string,
  text: string,
  onRefresh?: () => void | Promise<void>,
): void {
  mount(
    host,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h2", {}, title),
        onRefresh
          ? el(
              "div",
              { class: "right" },
              el("button", { class: "btn sm ghost", onClick: () => void onRefresh() }, "Refresh"),
            )
          : null,
      ),
      el("pre", { class: "app-out" }, text),
    ),
  );
}

/** Last line / short tail of a command output, for a toast. */
function tail(s: string): string {
  const lines = s.trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] ?? s;
  return last.length > 120 ? last.slice(-120) : last;
}

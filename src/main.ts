/**
 * CE Host — app shell.
 *
 * Pure-web SPA (Vite + TypeScript) that imports @ce-net/sdk and talks to a local CE
 * node's HTTP+SSE API. No framework: a single reactive Store fans out to panels that
 * each render into their own container. The shell owns navigation, the always-visible
 * overview header, and the web BYO-token banner.
 *
 * TAURI UPGRADE PATH (see docs/design.md): wrap this exact bundle in a Tauri window.
 * The Rust `src-tauri` side then (1) supervises `ce start` (one-click onboarding, tray
 * "still earning in background"), (2) reads `~/.local/share/ce/api.token` off disk and
 * injects it over IPC (the browser cannot read a chmod-600 file), and (3) applies the
 * CapsConfig as `ce start` flags + enforces the scheduler's graceful drain. None of the
 * panels change — they already consume the Store; only the token source + lifecycle
 * controls become real. This file is deliberately framework-free to make that wrap easy.
 */

import "./app.css";
// Shared @ce-net/ui design tokens + component styles (.ce-card / .ce-wallet / .ce-chip / …),
// imported once so the wallet panel renders correctly.
import "@ce-net/ui/tokens.css";
import { Store } from "./stores/store.js";
import { el, mount } from "./lib/dom.js";
import { loadConfig, saveConfig } from "./lib/config.js";
import { renderHeader } from "./panels/header.js";
import { renderJobs } from "./panels/jobs.js";
import { renderCaps } from "./panels/caps.js";
import { renderAtlas } from "./panels/atlas.js";
import { renderGrants } from "./panels/grants.js";
import { onboardingComplete, renderOnboarding } from "./panels/onboarding.js";
import { renderWallet } from "./panels/wallet.js";
import { isTauri, nodeStatus, readToken } from "./lib/tauri.js";

type ViewId = "jobs" | "wallet" | "caps" | "atlas" | "grants";

interface NavSpec {
  id: ViewId;
  label: string;
  ico: string;
}

const NAV: NavSpec[] = [
  { id: "jobs", label: "Jobs", ico: "▤" },
  { id: "wallet", label: "Wallet", ico: "◇" },
  { id: "caps", label: "Resource caps", ico: "▣" },
  { id: "atlas", label: "Mesh atlas", ico: "◈" },
  { id: "grants", label: "Capabilities", ico: "⬡" },
];

class App {
  private store = new Store();
  private view: ViewId = "jobs";
  private app = document.getElementById("app")!;

  private railEl = el("aside", { class: "rail" });
  private mainEl = el("main", { class: "main" });
  private headerEl = el("div", {});
  private bannerEl = el("div", {});
  private viewEl = el("div", { class: "view" });
  private overlayEl = el("div", {});

  start(): void {
    mount(this.app, this.railEl, this.mainEl, this.overlayEl);
    mount(this.mainEl, this.headerEl, this.bannerEl, this.viewEl);

    // Native shell: adopt the supervised node's base URL + on-disk api.token so authed
    // calls (kill / revoke / name claim) work without the user pasting anything. The
    // browser cannot read the chmod-600 token; the Rust side hands it over via IPC.
    void this.adoptNativeToken();

    // First run → show the onboarding wizard over everything. Tauri drives real
    // detect/install/start; the web build degrades to "point at a node".
    if (!onboardingComplete()) {
      renderOnboarding(this.store, this.overlayEl, () => {
        this.overlayEl.replaceChildren();
        this.renderAll();
      });
    }

    // Re-render on every store change (cheap: panels diff via full re-render of their
    // own container only; volume here is modest).
    this.store.subscribe(() => this.renderLive());

    // Cross-panel nav (e.g. the jobs empty-state links to caps).
    window.addEventListener("ce-host:nav", (e) => {
      const id = (e as CustomEvent).detail as ViewId;
      this.go(id);
    });

    // A 1s ticker keeps elapsed timers fresh even without new data.
    window.setInterval(() => this.renderLive(), 1000);

    this.store.start();
    this.renderAll();
  }

  /**
   * In the Tauri shell, ask the supervisor for the live node snapshot + the api.token
   * read off disk, and reconfigure the store to use them. No-op in web mode (isTauri()
   * false) so the pure-web fallback path is untouched.
   */
  private async adoptNativeToken(): Promise<void> {
    if (!isTauri()) return;
    try {
      const snap = await nodeStatus();
      const token = snap.token ?? (await readToken());
      if (token) {
        const cfg = loadConfig();
        saveConfig({ baseUrl: snap.baseUrl || cfg.baseUrl, token });
        this.store.reconfigure(snap.baseUrl || cfg.baseUrl, token);
      } else if (snap.baseUrl) {
        this.store.reconfigure(snap.baseUrl, undefined);
      }
    } catch {
      // Supervisor not reachable yet; the wizard / banner remains the fallback.
    }
  }

  private go(id: ViewId): void {
    this.view = id;
    this.renderAll();
  }

  private renderAll(): void {
    this.renderRail();
    this.renderHeaderAndBanner();
    this.renderView();
  }

  /**
   * Re-render only the live-updating surfaces. The form-heavy views (caps, grants)
   * own user input and are NOT re-rendered on the live tick — they only refresh on
   * explicit interaction — so a drag or a half-typed field is never clobbered by a
   * background poll. Jobs/atlas are pure data and refresh freely.
   */
  private renderLive(): void {
    renderHeader(this.store, this.headerEl);
    this.renderRail();
    if (this.view === "jobs" || this.view === "atlas") this.renderView();
  }

  private renderRail(): void {
    const cfg = loadConfig();
    const runningCount = this.store.state.jobs.filter((j) => j.status === "running").length;
    const items = NAV.map((n) =>
      el(
        "div",
        {
          class: `nav-item ${this.view === n.id ? "active" : ""}`,
          onClick: () => this.go(n.id),
        },
        el("span", { class: "ico" }, n.ico),
        el("span", {}, n.label),
        n.id === "jobs" && runningCount > 0
          ? el("span", { class: "badge" }, String(runningCount))
          : null,
      ),
    );

    mount(
      this.railEl,
      el(
        "div",
        { class: "brand" },
        el("div", { class: "mark" }),
        el(
          "div",
          { class: "name" },
          "CE Host",
          el("small", {}, "compute hosting"),
        ),
      ),
      ...items,
      el("div", { class: "spacer" }),
      el(
        "div",
        { class: "rail-foot" },
        cfg.baseUrl,
        el("br", {}),
        this.store.state.status ? `h ${this.store.state.status.height}` : "—",
      ),
    );
  }

  private renderHeaderAndBanner(): void {
    renderHeader(this.store, this.headerEl);
    this.renderBanner();
  }

  /**
   * Web BYO-token banner. Read panels work without a token; mutating actions (kill,
   * revoke) need one. In the Tauri shell this banner is hidden — the supervisor injects
   * the token from disk. Token is kept in app-local config only if the user opts in.
   */
  private renderBanner(): void {
    const cfg = loadConfig();
    if (cfg.token) {
      this.bannerEl.replaceChildren();
      return;
    }
    const tokenInput = el("input", {
      type: "password",
      placeholder: "CE_API_TOKEN (needed for kill / revoke)",
      value: "",
    });
    const urlInput = el("input", {
      type: "text",
      placeholder: "node base URL",
      value: cfg.baseUrl,
      style: "max-width:180px;flex:none",
    });
    const banner = el(
      "div",
      { class: "view", style: "padding-bottom:0" },
      el(
        "div",
        { class: "token-banner" },
        el("span", {}, "Read-only mode."),
        urlInput,
        tokenInput,
        el(
          "button",
          {
            class: "btn sm primary",
            onClick: () => {
              const url = (urlInput.value || cfg.baseUrl).trim();
              const tok = (tokenInput.value || "").trim();
              saveConfig(tok ? { baseUrl: url, token: tok } : { baseUrl: url });
              this.store.reconfigure(url, tok || undefined);
              this.renderAll();
            },
          },
          "Connect",
        ),
      ),
    );
    mount(this.bannerEl, banner);
  }

  private renderView(): void {
    switch (this.view) {
      case "jobs":
        renderJobs(this.store, this.viewEl);
        break;
      case "wallet":
        renderWallet(this.store, this.viewEl);
        break;
      case "caps":
        renderCaps(this.store, this.viewEl);
        break;
      case "atlas":
        renderAtlas(this.store, this.viewEl);
        break;
      case "grants":
        renderGrants(this.store, this.viewEl);
        break;
    }
  }
}

new App().start();

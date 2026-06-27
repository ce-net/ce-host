/**
 * CE Desktop — app shell (repo: ce-host).
 *
 * The flagship native UI for ce-net: one machine's node, made legible. Pure-web SPA
 * (Vite + TypeScript) that imports @ce-net/sdk and talks to a local CE node's HTTP+SSE
 * API. No framework: a single reactive Store fans out to panels (Jobs, Network, Explorer,
 * Apps, Wallet, Caps, Capabilities) that each render into their own container. The shell
 * owns navigation, the always-visible overview header, and the web BYO-token banner.
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
import { renderNetwork } from "./panels/network.js";
import { renderExplorer } from "./panels/explorer.js";
import { renderApps } from "./panels/apps.js";
import { renderGrants } from "./panels/grants.js";
import { onboardingComplete, renderOnboarding } from "./panels/onboarding.js";
import { renderWallet } from "./panels/wallet.js";
import { bridgeAvailable } from "@ce-net/sdk";
import { resolveHost, hostIsManaged } from "./lib/host.js";
import { parsePairing } from "./lib/pairing.js";

type ViewId = "jobs" | "network" | "explorer" | "apps" | "wallet" | "caps" | "grants";

interface NavSpec {
  id: ViewId;
  label: string;
  ico: string;
}

/** The non-standard PWA install event (absent from lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const NAV: NavSpec[] = [
  { id: "jobs", label: "Jobs", ico: "▤" },
  { id: "network", label: "Network", ico: "◈" },
  { id: "explorer", label: "Explorer", ico: "▦" },
  { id: "apps", label: "Apps", ico: "⬢" },
  { id: "wallet", label: "Wallet", ico: "◇" },
  { id: "caps", label: "Resource caps", ico: "▣" },
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

  /** Captured `beforeinstallprompt` event (PWA "Install app"), if the browser offered one. */
  private installPrompt: BeforeInstallPromptEvent | null = null;

  /**
   * Whether the resolved transport needs no pasted token (desktop supervisor / in-browser
   * bridge). False for the companion (mobile / browser BYO) path, which shows the connect +
   * pairing banner. Set by {@link adoptHost}; this is the accurate signal (the sync
   * `hostIsManaged` cannot tell desktop Tauri from mobile Tauri).
   */
  private hostManaged = false;

  start(): void {
    mount(this.app, this.railEl, this.mainEl, this.overlayEl);
    mount(this.mainEl, this.headerEl, this.bannerEl, this.viewEl);

    // Resolve the node transport for this shell (desktop supervisor / in-browser bridge /
    // same-origin proxy / BYO) and point the Store at it. Panels never learn which.
    void this.adoptHost();

    // First run → show the onboarding wizard over everything. Tauri drives real
    // detect/install/start; the web build degrades to "point at a node". A browser that
    // is itself a node (bridge) is already connected, so the wizard is skipped.
    if (!onboardingComplete() && !bridgeAvailable()) {
      renderOnboarding(this.store, this.overlayEl, () => {
        this.overlayEl.replaceChildren();
        this.renderAll();
      });
    }

    // PWA: offline app shell + installability (no-op in the desktop shell / vite dev).
    this.registerServiceWorker();
    this.setupInstallPrompt();

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
   * Resolve the node transport for this shell and point the Store at it. The desktop and
   * BYO paths persist their URL/token to config; the bridge binding is ephemeral (its
   * sentinel URL must not become the saved default), so it is applied with persist:false.
   */
  private async adoptHost(): Promise<void> {
    try {
      const b = await resolveHost();
      this.hostManaged = b.kind === "tauri" || b.kind === "bridge";
      if (b.kind === "bridge") {
        this.store.reconfigure(b.baseUrl, undefined, {
          persist: false,
          ...(b.fetch ? { fetch: b.fetch } : {}),
        });
      } else {
        this.store.reconfigure(b.baseUrl, b.token, { persist: b.kind === "tauri" });
      }
      this.renderAll();
    } catch {
      // Resolution failed; the constructor's config-based client + the banner remain.
    }
  }

  /**
   * Register the service worker that gives the PWA an offline app shell. Skipped in the
   * desktop shell (the Tauri webview is not a PWA) and under the vite dev server (to avoid
   * caching a hot-reloading bundle). Best-effort: a failure never blocks the app.
   */
  private registerServiceWorker(): void {
    if (hostIsManaged() && !bridgeAvailable()) return; // desktop shell: not a PWA
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (typeof location !== "undefined" && location.port === "5180") return; // vite dev
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW unsupported / blocked; the app still runs online */
    });
  }

  /**
   * Capture the browser's install offer so we can surface an explicit "Install app" action
   * in the rail (instead of relying on the address-bar affordance). Cleared once installed.
   */
  private setupInstallPrompt(): void {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      this.installPrompt = e as BeforeInstallPromptEvent;
      this.renderRail();
    });
    window.addEventListener("appinstalled", () => {
      this.installPrompt = null;
      this.renderRail();
    });
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
    // Pure-data views refresh freely on the live tick. Form/async-owning views
    // (caps, grants, apps, wallet) are left alone so input is never clobbered.
    if (this.view === "jobs" || this.view === "network" || this.view === "explorer") {
      this.renderView();
    }
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
          "CE Desktop",
          el("small", {}, "your node on the mesh"),
        ),
      ),
      ...items,
      el("div", { class: "spacer" }),
      this.installPrompt
        ? el(
            "button",
            { class: "btn sm primary install-btn", onClick: () => void this.promptInstall() },
            "Install app",
          )
        : null,
      el(
        "div",
        { class: "rail-foot" },
        bridgeAvailable() ? "in-browser node" : cfg.baseUrl,
        el("br", {}),
        this.store.state.status ? `h ${this.store.state.status.height}` : "—",
      ),
    );
  }

  /** Fire the captured PWA install prompt, then clear it (one-shot per browser). */
  private async promptInstall(): Promise<void> {
    const ev = this.installPrompt;
    if (!ev) return;
    this.installPrompt = null;
    this.renderRail();
    try {
      await ev.prompt();
      await ev.userChoice;
    } catch {
      /* user dismissed or unsupported */
    }
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
    // Managed transports (desktop supervisor, in-browser bridge) need no pasted token.
    // The companion path (mobile / browser BYO) keeps the connect + pairing banner.
    if (cfg.token || this.hostManaged) {
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
    // Companion pairing: paste a `ce-pair:` link (or a URL) to fill both fields at once —
    // how a phone connects to the node on your laptop/desktop/relay (ce-fleet token model).
    const pairInput = el("input", {
      type: "text",
      placeholder: "paste pairing link (ce-pair:…)",
      style: "flex:1;min-width:160px",
      onInput: (e: Event) => {
        const p = parsePairing((e.target as HTMLInputElement).value);
        if (p) {
          urlInput.value = p.baseUrl;
          tokenInput.value = p.token ?? "";
        }
      },
    });
    const banner = el(
      "div",
      { class: "view", style: "padding-bottom:0" },
      el(
        "div",
        { class: "token-banner" },
        el("span", {}, "Connect to your node."),
        pairInput,
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
      case "network":
        renderNetwork(this.store, this.viewEl);
        break;
      case "explorer":
        renderExplorer(this.store, this.viewEl);
        break;
      case "apps":
        renderApps(this.store, this.viewEl);
        break;
      case "wallet":
        renderWallet(this.store, this.viewEl);
        break;
      case "caps":
        renderCaps(this.store, this.viewEl);
        break;
      case "grants":
        renderGrants(this.store, this.viewEl);
        break;
    }
  }
}

new App().start();

/**
 * Onboarding wizard — 4 steps (PLAN/03-hosting-ui.md §8).
 *
 *   1. INSTALL      detect `ce`; offer one-click install if missing (native only)
 *   2. START        run `ce start`, wait for /health, read api.token off disk
 *   3. NAME         optional: claim a human-readable handle via the SDK (POST /names/claim)
 *   4. CAPS         default sliders to ~50% cores / RAM, "Always host"
 *
 * Shown on first run. In the native Tauri shell every step drives real supervisor
 * commands (detect/install/start, token read). In the pure-web fallback the shell is
 * absent, so steps 1–2 collapse to "point me at a node" (base URL + optional token) and
 * the wizard still produces a usable, configured dashboard — Tauri is an enhancement,
 * the web build remains a complete fallback.
 *
 * No emojis, no floats for money (no money crosses this flow). All copy follows the CE
 * design language: terse, honest about cost, never over-promising.
 */

import { el, mount } from "../lib/dom.js";
import { toast } from "../lib/toast.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import {
  isTauri,
  detectCe,
  installCe,
  startNode,
  readToken,
  type CeInstall,
  type NodeSnapshot,
} from "../lib/tauri.js";
import type { Store } from "../stores/store.js";

const DONE_KEY = "ce-host.onboarded.v1";

/** True if onboarding has already been completed (or skipped) on this device. */
export function onboardingComplete(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function markComplete(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* private mode: in-memory session only */
  }
}

interface WizardState {
  step: 1 | 2 | 3 | 4;
  install: CeInstall;
  node: NodeSnapshot | null;
  installing: boolean;
  starting: boolean;
  name: string;
  claimingName: boolean;
}

/**
 * Mount the wizard into a full-window overlay. `onFinish` is called once the operator
 * finishes or skips; the caller re-renders the dashboard and (in native mode) the store
 * has by then been reconfigured with the real base URL + token.
 */
export function renderOnboarding(store: Store, host: HTMLElement, onFinish: () => void): void {
  const native = isTauri();
  const state: WizardState = {
    step: 1,
    install: { installed: false },
    node: null,
    installing: false,
    starting: false,
    name: "",
    claimingName: false,
  };

  const overlay = el("div", { class: "onboard-overlay" });
  const card = el("div", { class: "onboard-card" });
  overlay.append(card);

  const rerender = () => draw(store, native, state, card, rerender, host, onFinish);

  // Kick off an initial detect in native mode so step 1 lands on the right state.
  if (native) {
    void detectCe().then((i) => {
      state.install = i;
      if (i.installed) state.step = 2;
      rerender();
    });
  }

  rerender();
  mount(host, overlay);
}

function finish(host: HTMLElement, onFinish: () => void): void {
  markComplete();
  host.replaceChildren();
  onFinish();
}

function draw(
  store: Store,
  native: boolean,
  st: WizardState,
  card: HTMLElement,
  rerender: () => void,
  host: HTMLElement,
  onFinish: () => void,
): void {
  const header = el(
    "div",
    { class: "onboard-head" },
    el("div", { class: "onboard-mark" }),
    el(
      "div",
      {},
      el("h1", {}, "Welcome to CE Desktop"),
      el(
        "p",
        { class: "onboard-sub" },
        "Join your machine to the CE mesh in four steps. ",
        "Host more than you spend and your ratio climbs — like seeding.",
      ),
    ),
  );

  const steps = el(
    "div",
    { class: "onboard-steps" },
    stepDot(1, "Install", st.step),
    stepDot(2, "Start", st.step),
    stepDot(3, "Name", st.step),
    stepDot(4, "Caps", st.step),
  );

  let body: HTMLElement;
  switch (st.step) {
    case 1:
      body = stepInstall(native, st, rerender);
      break;
    case 2:
      body = stepStart(store, native, st, rerender);
      break;
    case 3:
      body = stepName(store, st, rerender);
      break;
    case 4:
      body = stepCaps(store, host, onFinish);
      break;
  }

  const skip = el(
    "button",
    {
      class: "btn ghost sm",
      onClick: () => finish(host, onFinish),
    },
    "Skip setup",
  );

  mount(
    card,
    header,
    steps,
    el("div", { class: "onboard-body" }, body),
    el("div", { class: "onboard-foot" }, skip),
  );
}

function stepDot(n: number, label: string, cur: number): HTMLElement {
  const cls = n < cur ? "done" : n === cur ? "active" : "";
  return el(
    "div",
    { class: `onboard-step ${cls}` },
    el("span", { class: "n" }, n < cur ? "✓" : String(n)),
    el("span", { class: "l" }, label),
  );
}

// ---- Step 1: install / detect ----

function stepInstall(native: boolean, st: WizardState, rerender: () => void): HTMLElement {
  if (!native) {
    // Web fallback: nothing to install locally; we connect to an existing node.
    return el(
      "div",
      {},
      el("h2", {}, "Connect to a node"),
      el(
        "p",
        { class: "muted" },
        "You are running the web build. CE Host cannot install or start a node from the ",
        "browser, so point it at a CE node you already run. The desktop app does this ",
        "automatically.",
      ),
      el(
        "div",
        { class: "onboard-actions" },
        el(
          "button",
          { class: "btn primary", onClick: () => ((st.step = 2), rerender()) },
          "Continue",
        ),
      ),
    );
  }

  if (st.install.installed) {
    return el(
      "div",
      {},
      el("h2", {}, "CE is installed"),
      el(
        "p",
        { class: "muted" },
        `Found ${st.install.path ?? "ce"}${st.install.version ? ` (${st.install.version})` : ""}.`,
      ),
      el(
        "div",
        { class: "onboard-actions" },
        el(
          "button",
          { class: "btn primary", onClick: () => ((st.step = 2), rerender()) },
          "Next: start hosting",
        ),
      ),
    );
  }

  return el(
    "div",
    {},
    el("h2", {}, "Install the CE node"),
    el(
      "p",
      { class: "muted" },
      "No `ce` binary was found. CE Host can install it for you using your platform's ",
      "package manager (Homebrew, install.sh, or Scoop).",
    ),
    el(
      "div",
      { class: "onboard-actions" },
      el(
        "button",
        {
          class: "btn primary",
          onClick: async () => {
            if (st.installing) return;
            st.installing = true;
            rerender();
            toast("Installing ce…", "ok");
            try {
              st.install = await installCe();
              if (st.install.installed) {
                toast("CE installed.", "ok");
                st.step = 2;
              } else {
                toast("Install did not complete. Install ce manually, then retry.", "err");
              }
            } catch (e) {
              toast(`Install failed: ${msg(e)}`, "err");
            } finally {
              st.installing = false;
              rerender();
            }
          },
        },
        st.installing ? "Installing…" : "Install ce",
      ),
      el(
        "button",
        {
          class: "btn ghost",
          onClick: async () => {
            st.install = await detectCe();
            if (st.install.installed) st.step = 2;
            rerender();
          },
        },
        "I installed it — re-check",
      ),
    ),
  );
}

// ---- Step 2: start / connect ----

function stepStart(
  store: Store,
  native: boolean,
  st: WizardState,
  rerender: () => void,
): HTMLElement {
  if (!native) {
    const cfg = loadConfig();
    const url = el("input", {
      class: "cap-input",
      style: "width:100%",
      value: cfg.baseUrl,
      placeholder: "node base URL (e.g. http://localhost:8844 or /ce)",
    });
    const tok = el("input", {
      class: "cap-input",
      style: "width:100%",
      type: "password",
      placeholder: "CE_API_TOKEN (optional; needed for kill / revoke)",
    });
    return el(
      "div",
      {},
      el("h2", {}, "Point at your node"),
      el(
        "p",
        { class: "muted" },
        "Read-only panels work without a token. A token (from the node's data dir) is ",
        "needed for actions like kill and revoke.",
      ),
      el(
        "div",
        { style: "display:flex;flex-direction:column;gap:10px;margin:14px 0" },
        labeled("Base URL", url),
        labeled("API token", tok),
      ),
      el(
        "div",
        { class: "onboard-actions" },
        el(
          "button",
          {
            class: "btn primary",
            onClick: async () => {
              const base = (url.value || cfg.baseUrl).trim();
              const token = (tok.value || "").trim();
              saveConfig(token ? { baseUrl: base, token } : { baseUrl: base });
              store.reconfigure(base, token || undefined);
              const ok = await store.client.health().catch(() => false);
              if (!ok) {
                toast("Could not reach that node. Check the URL and that `ce start` is running.", "warn");
              }
              st.step = 3;
              rerender();
            },
          },
          "Connect & continue",
        ),
      ),
    );
  }

  const snap = st.node;
  const healthy = snap?.healthy ?? false;
  return el(
    "div",
    {},
    el("h2", {}, "Start hosting"),
    el(
      "p",
      { class: "muted" },
      "This launches your node (`ce start`) and waits until it is healthy. Your node ",
      "then mines uptime rewards and can accept hosted jobs.",
    ),
    snap
      ? el(
          "div",
          { class: healthy ? "warn-box ok-box" : "warn-box" },
          el("span", { class: healthy ? "dot on" : "dot warn" }),
          `  Node ${snap.state}${healthy ? " — healthy" : ""}.`,
          snap.note ? ` ${snap.note}` : "",
        )
      : null,
    el(
      "div",
      { class: "onboard-actions" },
      healthy
        ? el(
            "button",
            { class: "btn primary", onClick: () => ((st.step = 3), rerender()) },
            "Next: name yourself",
          )
        : el(
            "button",
            {
              class: "btn primary",
              onClick: async () => {
                if (st.starting) return;
                st.starting = true;
                rerender();
                toast("Starting node…", "ok");
                try {
                  const snapOut = await startNode();
                  st.node = snapOut;
                  // Hand the on-disk api.token + base URL to the live store.
                  const token = snapOut.token ?? (await readToken());
                  saveConfig(token ? { baseUrl: snapOut.baseUrl, token } : { baseUrl: snapOut.baseUrl });
                  store.reconfigure(snapOut.baseUrl, token);
                  if (snapOut.healthy) {
                    toast("Node is up and earning.", "ok");
                    st.step = 3;
                  } else {
                    toast("Node started but is not healthy yet — give it a moment, then retry.", "warn");
                  }
                } catch (e) {
                  toast(`Start failed: ${msg(e)}`, "err");
                } finally {
                  st.starting = false;
                  rerender();
                }
              },
            },
            st.starting ? "Starting…" : "Start hosting",
          ),
    ),
  );
}

// ---- Step 3: name (optional) ----

function stepName(store: Store, st: WizardState, rerender: () => void): HTMLElement {
  const input = el("input", {
    class: "cap-input",
    style: "width:100%",
    value: st.name,
    placeholder: "a handle, e.g. aurora-rk",
    onInput: (e: Event) => (st.name = (e.target as HTMLInputElement).value.trim()),
  });
  return el(
    "div",
    {},
    el("h2", {}, "Name yourself"),
    el(
      "p",
      { class: "muted" },
      "Optional. Claim a human-readable handle so peers see a name instead of a hex id. ",
      "It is yours once mined (~a minute). You can skip and do this later.",
    ),
    el("div", { style: "margin:14px 0" }, labeled("Handle", input)),
    el(
      "div",
      { class: "onboard-actions" },
      el(
        "button",
        {
          class: "btn primary",
          onClick: async () => {
            const name = st.name.trim();
            if (!name) {
              st.step = 4;
              rerender();
              return;
            }
            if (st.claimingName) return;
            st.claimingName = true;
            rerender();
            try {
              await store.client.names.claim(name);
              saveConfig({ nodeName: name });
              toast(`Claiming "${name}" — yours once mined.`, "ok");
              st.step = 4;
            } catch (e) {
              // Most likely no token (401) or balance/duplicate; let them skip.
              toast(`Could not claim name: ${msg(e)}. You can set it later.`, "warn");
            } finally {
              st.claimingName = false;
              rerender();
            }
          },
        },
        st.claimingName ? "Claiming…" : st.name ? "Claim & continue" : "Skip naming",
      ),
    ),
  );
}

// ---- Step 4: caps ----

function stepCaps(store: Store, host: HTMLElement, onFinish: () => void): HTMLElement {
  const cfg = loadConfig();
  // Default to ~50% of the node's advertised capacity if we can see it, else config.
  const selfAtlas = store.state.atlas.find((a) => a.nodeId === store.selfNodeId);
  const sysCores = Math.max(selfAtlas?.cpuCores ?? 8, 1);
  const sysMem = Math.max(selfAtlas?.memMb ?? 16384, 1024);
  const defCores = Math.max(1, Math.floor(sysCores / 2));
  const defMem = Math.max(1024, Math.floor(sysMem / 2 / 1024) * 1024);

  let cores = cfg.caps.cpuCores || defCores;
  let memMb = cfg.caps.memMb || defMem;

  const coresOut = el("span", { class: "readout" }, `${cores} / ${sysCores}`);
  const memOut = el("span", { class: "readout" }, `${Math.round(memMb / 1024)} / ${Math.round(sysMem / 1024)} GB`);

  const coreSlider = el("input", {
    type: "range",
    min: "1",
    max: String(sysCores),
    step: "1",
    value: String(cores),
    onInput: (e: Event) => {
      cores = Number((e.target as HTMLInputElement).value);
      coresOut.textContent = `${cores} / ${sysCores}`;
    },
  });
  const memSlider = el("input", {
    type: "range",
    min: "1024",
    max: String(sysMem),
    step: "1024",
    value: String(memMb),
    onInput: (e: Event) => {
      memMb = Number((e.target as HTMLInputElement).value);
      memOut.textContent = `${Math.round(memMb / 1024)} / ${Math.round(sysMem / 1024)} GB`;
    },
  });

  return el(
    "div",
    {},
    el("h2", {}, "Set your caps"),
    el(
      "p",
      { class: "muted" },
      "How much of this machine to offer. Defaults to about half — generous but leaves ",
      "headroom. You can change these any time on the Resource caps panel.",
    ),
    el(
      "div",
      { class: "cap-row", style: "margin-top:14px" },
      el("div", { class: "label" }, "CPU cores offered"),
      coreSlider,
      coresOut,
    ),
    el(
      "div",
      { class: "cap-row" },
      el("div", { class: "label" }, "Memory offered"),
      memSlider,
      memOut,
    ),
    el(
      "div",
      { class: "onboard-actions" },
      el(
        "button",
        {
          class: "btn primary",
          onClick: () => {
            saveConfig({
              caps: {
                ...cfg.caps,
                cpuCores: cores,
                memMb,
                scheduler: { ...cfg.caps.scheduler, mode: "always" },
              },
            });
            toast("You're live. Close the window — CE keeps earning in the tray.", "ok");
            finish(host, onFinish);
          },
        },
        "Finish — start earning",
      ),
    ),
  );
}

// ---- helpers ----

function labeled(label: string, input: HTMLElement): HTMLElement {
  return el(
    "label",
    { style: "display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--faint)" },
    label,
    input,
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

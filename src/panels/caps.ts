/**
 * Resource caps + scheduler.
 *
 * Caps (cores/mem/max-jobs/throttle) and scheduler intent (window / battery / cpu)
 * are written to the app-local CapsConfig. In MVP-web mode there is no node-side
 * "set caps" or "pause" primitive (that would mutate host behavior — an app/lifecycle
 * concern, not a CE primitive). So this panel persists intent and, in the Tauri shell,
 * the Rust supervisor applies caps as `ce start` flags and toggles node state.
 *
 * CRITICAL (economics): the "pause hosting" control is NOT a naive node restart.
 * It is a graceful-drain action: stop *accepting new* work, let running jobs finish,
 * and surface the economic cost of pausing (forfeited uptime rewards, job-expiry risk).
 * We never ship a one-click money-losing button without that warning + drain semantics.
 */

import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { confirmModal } from "../lib/modal.js";
import { toast } from "../lib/toast.js";
import { loadConfig, saveConfig, type CapsConfig } from "../lib/config.js";
import { fmtMem } from "../lib/format.js";
import {
  isTauri,
  pauseHosting as tauriPause,
  resumeHosting as tauriResume,
} from "../lib/tauri.js";

export type HostMode = "hosting" | "draining" | "paused";
let hostMode: HostMode = "hosting";

/**
 * The graceful-drain pause guard: pausing while jobs are in-flight must NOT jump straight to
 * `paused` (which models "advertise nothing / safe to stop"). It enters `draining` so running
 * jobs are left to finish and still settle; only an empty host pauses immediately. This is the
 * single decision that prevents a one-click money-losing shutdown.
 */
export function drainModeFor(runningCount: number): HostMode {
  return runningCount > 0 ? "draining" : "paused";
}

/**
 * Cores to restore on resume: if the cap was zeroed by a pause, come back at half the system
 * cores (min 1); otherwise keep whatever the user had set. Pure — no config/DOM access.
 */
export function restoreCores(currentCap: number, sysCores: number): number {
  return currentCap === 0 ? Math.max(1, Math.floor(sysCores / 2)) : currentCap;
}

export function renderCaps(store: Store, root: HTMLElement): void {
  const cfg = loadConfig();
  const caps = cfg.caps;

  // System ceilings for the sliders: prefer the node's own atlas entry, else sane defaults.
  const selfAtlas = store.state.atlas.find((a) => a.nodeId === store.selfNodeId);
  const maxCores = Math.max(selfAtlas?.cpuCores ?? 8, caps.cpuCores, 1);
  const maxMemMb = Math.max(selfAtlas?.memMb ?? 16384, caps.memMb, 1024);

  const update = (patch: Partial<CapsConfig>) => {
    saveConfig({ caps: { ...caps, ...patch } });
    renderCaps(store, root);
  };

  const capsCard = el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "Resource caps")),
    el(
      "div",
      { class: "card-body" },
      sliderRow(
        "CPU cores offered",
        caps.cpuCores,
        1,
        maxCores,
        1,
        `${caps.cpuCores} / ${maxCores}`,
        (v) => update({ cpuCores: v }),
      ),
      sliderRow(
        "Memory offered",
        caps.memMb,
        1024,
        maxMemMb,
        1024,
        `${fmtMem(caps.memMb)} / ${fmtMem(maxMemMb)}`,
        (v) => update({ memMb: v }),
      ),
      numberRow("Max concurrent jobs", caps.maxJobs, 1, 64, (v) => update({ maxJobs: v })),
      throttleRow(caps, update),
    ),
  );

  const schedCard = el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "Scheduler")),
    el("div", { class: "card-body" }, schedulerBody(caps, update), stateNow(store, root)),
  );

  mount(root, capsCard, schedCard);
}

function sliderRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  readout: string,
  onChange: (v: number) => void,
): HTMLElement {
  return el(
    "div",
    { class: "cap-row" },
    el("div", { class: "label" }, label),
    el("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      onInput: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)),
    }),
    el("div", { class: "readout" }, readout),
  );
}

function numberRow(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (v: number) => void,
): HTMLElement {
  return el(
    "div",
    { class: "cap-row" },
    el("div", { class: "label" }, label),
    el("div", {}),
    el("input", {
      class: "cap-input",
      type: "number",
      min: String(min),
      max: String(max),
      value: String(value),
      onChange: (e: Event) => {
        const v = Math.max(min, Math.min(max, Number((e.target as HTMLInputElement).value)));
        onChange(v);
      },
    }),
  );
}

function throttleRow(caps: CapsConfig, update: (p: Partial<CapsConfig>) => void): HTMLElement {
  return el(
    "div",
    { class: "cap-row" },
    el("div", { class: "label" }, "Network throttle"),
    el(
      "div",
      { style: "display:flex;gap:14px;align-items:center" },
      el("span", { style: "color:var(--faint)" }, "up"),
      el("input", {
        class: "cap-input",
        type: "number",
        min: "0",
        value: String(caps.netUpMbs ?? 0),
        onChange: (e: Event) =>
          update({ netUpMbs: Number((e.target as HTMLInputElement).value) }),
      }),
      el("span", { style: "color:var(--faint)" }, "down"),
      el("input", {
        class: "cap-input",
        type: "number",
        min: "0",
        value: String(caps.netDownMbs ?? 0),
        onChange: (e: Event) =>
          update({ netDownMbs: Number((e.target as HTMLInputElement).value) }),
      }),
      el("span", { class: "advisory" }, "MB/s (advisory)"),
    ),
    el("div", {}),
  );
}

function schedulerBody(caps: CapsConfig, update: (p: Partial<CapsConfig>) => void): HTMLElement {
  const sc = caps.scheduler;
  return el(
    "div",
    {},
    el(
      "label",
      { class: "sched-opt" },
      el("input", {
        type: "radio",
        name: "sched-mode",
        checked: sc.mode === "always",
        onChange: () => update({ scheduler: { ...sc, mode: "always" } }),
      }),
      "Always host",
    ),
    el(
      "label",
      { class: "sched-opt" },
      el("input", {
        type: "radio",
        name: "sched-mode",
        checked: sc.mode === "window",
        onChange: () => update({ scheduler: { ...sc, mode: "window" } }),
      }),
      "Host only during window",
      el("input", {
        class: "cap-input",
        type: "time",
        value: sc.windowStart,
        style: "margin-left:10px",
        onChange: (e: Event) =>
          update({ scheduler: { ...sc, windowStart: (e.target as HTMLInputElement).value } }),
      }),
      el("span", { style: "color:var(--faint)" }, "–"),
      el("input", {
        class: "cap-input",
        type: "time",
        value: sc.windowEnd,
        onChange: (e: Event) =>
          update({ scheduler: { ...sc, windowEnd: (e.target as HTMLInputElement).value } }),
      }),
    ),
    el(
      "label",
      { class: "sched-opt" },
      el("input", {
        type: "checkbox",
        checked: sc.pauseOnBattery,
        onChange: (e: Event) =>
          update({ scheduler: { ...sc, pauseOnBattery: (e.target as HTMLInputElement).checked } }),
      }),
      "Pause when on battery",
    ),
    el(
      "label",
      { class: "sched-opt" },
      el("input", {
        type: "checkbox",
        checked: (sc.pauseCpuPct ?? 0) > 0,
        onChange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          update({ scheduler: { ...sc, pauseCpuPct: on ? (sc.pauseCpuPct ?? 80) : 0 } });
        },
      }),
      "Pause when CPU >",
      el("input", {
        class: "cap-input",
        type: "number",
        min: "1",
        max: "100",
        value: String(sc.pauseCpuPct ?? 80),
        style: "width:64px;margin:0 6px",
        onChange: (e: Event) =>
          update({
            scheduler: { ...sc, pauseCpuPct: Number((e.target as HTMLInputElement).value) },
          }),
      }),
      "% for 5 min",
    ),
  );
}

function stateNow(store: Store, root: HTMLElement): HTMLElement {
  const cfg = loadConfig();
  const within = cfg.caps.scheduler.mode === "always" || withinWindow(cfg.caps.scheduler);
  const word =
    hostMode === "paused"
      ? "PAUSED"
      : hostMode === "draining"
        ? "DRAINING"
        : within
          ? "HOSTING"
          : "IDLE (outside window)";

  const runningCount = store.state.jobs.filter((j) => j.status === "running").length;

  const action =
    hostMode === "paused"
      ? el(
          "button",
          { class: "btn primary", onClick: () => void resumeHosting(store, root) },
          "Resume hosting",
        )
      : el(
          "button",
          { class: "btn danger", onClick: () => void pauseHosting(store, root, runningCount) },
          "Pause hosting now",
        );

  return el(
    "div",
    { class: "state-now" },
    el("span", { class: "label" }, "State now:"),
    el("span", { class: "val" }, word),
    el("span", { class: "right" }, action),
  );
}

/**
 * Graceful-drain pause. NOT a node restart. We:
 *  1. surface the economic cost (forfeited uptime rewards + running-job expiry risk),
 *  2. choose to *drain* (stop accepting new work; let running jobs finish) by default,
 *  3. only after explicit confirmation flip into a drain state.
 *
 * In the web/MVP tier there is no node "stop accepting" primitive, so we set caps to
 * 0 offered cores (the node advertises no capacity ⇒ receives no new bids) and mark the
 * mode `draining`/`paused` — running jobs are deliberately left untouched. The Tauri
 * supervisor performs the same as a real drain (stop advertising + decline new RPCs),
 * never a `ce stop` that would kill in-flight hosted jobs and forfeit their settlement.
 */
async function pauseHosting(store: Store, root: HTMLElement, runningCount: number): Promise<void> {
  const warn = el(
    "div",
    {},
    el(
      "div",
      { class: "warn-box" },
      el("b", {}, "Pausing has an economic cost. "),
      "While paused your node stops earning uptime rewards and stops advertising ",
      "capacity. This is a ",
      el("b", {}, "graceful drain"),
      ", not a shutdown: ",
      runningCount > 0
        ? `the ${runningCount} job(s) currently running are left to finish so you still get paid for them.`
        : "no jobs are running, so nothing in-flight is affected.",
      " New work will not be accepted until you resume.",
    ),
    runningCount > 0
      ? el(
          "p",
          { style: "margin-top:10px;color:var(--muted)" },
          "Do not fully stop the node while jobs are running — that forfeits their ",
          "settlement and can register as job-expiry against your history.",
        )
      : null,
  );

  const ok = await confirmModal({
    title: "Pause hosting (graceful drain)",
    body: warn,
    confirmLabel: "Drain & pause",
    danger: true,
  });
  if (!ok) return;

  hostMode = drainModeFor(runningCount);
  // Persist a 0-offer cap as the boundary-clean "advertise nothing" signal.
  const cfg = loadConfig();
  saveConfig({ caps: { ...cfg.caps, cpuCores: 0 } });

  // Native shell: drive the real graceful drain through the Tauri supervisor (stop
  // accepting/advertising new work; leave running jobs to finish; then idle — NOT a
  // node kill). Web mode keeps the in-app "advertise nothing" intent above.
  if (isTauri()) {
    try {
      const snap = await tauriPause();
      if (snap.note) toast(`Supervisor: ${snap.note}`, "ok");
    } catch (e) {
      toast(`Drain command failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }

  toast(
    runningCount > 0
      ? "Draining: no new jobs; running jobs will finish."
      : "Paused: not advertising capacity.",
    "warn",
  );
  // If jobs were running, transition draining → paused once they clear (poll-driven).
  if (hostMode === "draining") watchDrain(store, root);
  renderCaps(store, root);
}

function watchDrain(store: Store, root: HTMLElement): void {
  const iv = window.setInterval(() => {
    if (hostMode !== "draining") {
      clearInterval(iv);
      return;
    }
    const running = store.state.jobs.filter((j) => j.status === "running").length;
    if (running === 0) {
      hostMode = "paused";
      clearInterval(iv);
      toast("Drain complete — hosting paused.", "ok");
      renderCaps(store, root);
    }
  }, 4000);
}

async function resumeHosting(store: Store, root: HTMLElement): Promise<void> {
  hostMode = "hosting";
  // Restore a sensible offered-cores cap (half of system, min 1) if it was zeroed.
  const cfg = loadConfig();
  const selfAtlas = store.state.atlas.find((a) => a.nodeId === store.selfNodeId);
  const sys = selfAtlas?.cpuCores ?? 8;
  const restore = restoreCores(cfg.caps.cpuCores, sys);
  saveConfig({ caps: { ...cfg.caps, cpuCores: restore } });

  // Native shell: tell the supervisor to start advertising/accepting work again.
  if (isTauri()) {
    try {
      await tauriResume();
    } catch (e) {
      toast(`Resume command failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }

  toast("Hosting resumed.", "ok");
  renderCaps(store, root);
}

/** True if `now` falls inside the [start, end) window (handles overnight wrap). */
export function withinWindow(sc: CapsConfig["scheduler"], now: Date = new Date()): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(sc.windowStart);
  const end = toMinutes(sc.windowEnd);
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // overnight wrap
}

function toMinutes(hhmm: string): number {
  const parts = hhmm.split(":");
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  return h * 60 + m;
}

/**
 * Overview header (always visible). Earnings, share ratio badge, bond/weight,
 * uptime, jobs running, up-compute, and a live credits/min — fed by /status,
 * /history, /atlas and the transaction-stream accrual (see store).
 */

import { Amount } from "@ce-net/sdk";
import { sparkline } from "@ce-net/ui";
import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { fmtCredits, fmtUptime, ratio, shortId, fmtMem } from "../lib/format.js";
import { loadConfig } from "../lib/config.js";

export function renderHeader(store: Store, root: HTMLElement): void {
  const s = store.state;
  const cfg = loadConfig();

  const dotClass =
    s.health === "online" ? "dot on" : s.health === "connecting" ? "dot warn" : "dot off";
  const stateWord =
    s.health === "online" ? "HOSTING" : s.health === "connecting" ? "CONNECTING" : "OFFLINE";

  const nodeName = cfg.nodeName ?? (s.status ? shortId(s.status.nodeId) : "—");
  const nidShort = s.status ? `(${shortId(s.status.nodeId)})` : "";

  const earned = s.selfHistory?.earned ?? Amount.ZERO;
  const spent = s.selfHistory?.spent ?? Amount.ZERO;
  const r = ratio(earned, spent);
  const ratioClass = r >= 1.5 ? "ratio-good" : r >= 1 ? "ratio-warn" : "ratio-bad";
  const ratioArrow = r >= 1 ? "▲" : "▼";

  const bond = s.status?.bond ?? Amount.ZERO;
  const weight = s.status?.weight ?? 0;

  const runningJobs = s.jobs.filter((j) => j.status === "running").length;

  // Up-compute = the node's own atlas entry (cores/mem offered), or caps fallback.
  const selfAtlas = s.atlas.find((a) => a.nodeId === store.selfNodeId);
  const upCores = selfAtlas?.cpuCores ?? cfg.caps.cpuCores;
  const upMem = selfAtlas?.memMb ?? cfg.caps.memMb;

  const uptimeSecs = cfg.hostStartedAt ? (Date.now() - cfg.hostStartedAt) / 1000 : 0;
  const crMin = store.selfCreditsPerMinAmount();
  const rateHistory = s.selfCreditsPerMinHistory;
  // A live earnings-rate sparkline (base-unit bigints → precise), shown once we have a trend.
  const rateSpark =
    rateHistory.length >= 2
      ? sparkline(rateHistory, { width: 64, height: 16, stroke: "var(--teal)", dot: false })
      : null;

  const header = el(
    "div",
    { class: "header" },
    el(
      "div",
      { class: "header-top" },
      el("span", { class: dotClass }),
      el(
        "span",
        { class: "who" },
        stateWord,
        el("span", { class: "nid" }, `node: ${nodeName} ${nidShort}`),
      ),
      el(
        "span",
        { class: "chain" },
        el("span", {}, "height ", el("b", {}, fmtNum(s.status?.height))),
        el("span", {}, "diff ", el("b", {}, fmtNum(s.status?.difficulty))),
        el("span", {}, "balance ", el("b", {}, `${fmtCredits(s.status?.balance ?? Amount.ZERO)} cr`)),
      ),
    ),
    el(
      "div",
      { class: "stats" },
      stat("Earned", `${fmtCredits(earned)} cr`),
      stat("Spent", `${fmtCredits(spent)} cr`),
      ratioStat(r, ratioClass, ratioArrow),
      stat("Bond", `${fmtCredits(bond)} cr`),
      stat("Weight", fmtNum(weight)),
    ),
    el(
      "div",
      { class: "subbar" },
      el("span", {}, "UPTIME ", el("b", {}, fmtUptime(uptimeSecs))),
      el("span", {}, "JOBS RUNNING ", el("b", {}, String(runningJobs))),
      el("span", {}, "UP ▲ ", el("b", {}, `${upCores} cores / ${fmtMem(upMem)}`)),
      el(
        "span",
        { class: "crmin-cell" },
        "credits/min ",
        el("b", {}, `~${fmtCredits(crMin, 2)}`),
        rateSpark,
      ),
    ),
  );

  mount(root, header);
}

function stat(k: string, v: string): HTMLElement {
  return el("div", { class: "stat" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v));
}

function ratioStat(r: number, cls: string, arrow: string): HTMLElement {
  return el(
    "div",
    { class: "stat" },
    el("div", { class: "k" }, "Ratio"),
    el(
      "div",
      { class: "v" },
      el(
        "span",
        { class: `ratio-badge ${cls}` },
        Number.isFinite(r) ? r.toFixed(2) : "∞",
        el("span", { class: "arrow" }, ` ${arrow}`),
      ),
    ),
  );
}

function fmtNum(n: number | undefined): string {
  if (n === undefined) return "—";
  return n.toLocaleString("en-US");
}

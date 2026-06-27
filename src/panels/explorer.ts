/**
 * Explorer view — the live pulse of the chain + mesh, read-only.
 *
 * Three surfaces, all from data the store already streams (no extra polling):
 *   - Recent blocks: the /blocks/stream ring (height, miner, tx count, age).
 *   - Live transactions: the /transactions/stream ring, every kind, newest first.
 *   - Capacity leaderboard: atlas peers ranked by offered cores.
 *
 * This is the in-app sibling of ce-explorer (the standalone read-only site); it shares
 * the same SDK types so the two never drift. Money stays an Amount end to end.
 */

import { type BlockEvent, type TxEvent, type TxKind } from "@ce-net/sdk";
import type { AtlasEntry } from "@ce-net/sdk";
import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { fmtAgo, fmtCredits, fmtMem, shortId } from "../lib/format.js";

export function renderExplorer(store: Store, root: HTMLElement): void {
  mount(
    root,
    el(
      "div",
      { class: "explorer-grid" },
      blocksCard(store),
      txCard(store),
    ),
    leaderboardCard(store),
  );
}

// ---- recent blocks ----

function blocksCard(store: Store): HTMLElement {
  const blocks = store.state.recentBlocks;
  const body =
    blocks.length === 0
      ? waiting("Waiting for the next block…")
      : el("div", { class: "feed" }, ...blocks.map(blockRow));
  return card("Recent blocks", body, store.state.status ? `height ${store.state.status.height}` : undefined);
}

function blockRow(b: BlockEvent): HTMLElement {
  return el(
    "div",
    { class: "feed-row" },
    el("span", { class: "feed-lead" }, `#${b.index}`),
    el("span", { class: "feed-mid mono" }, shortId(b.hash)),
    el("span", { class: "feed-tag" }, `${b.txCount} tx`),
    el("span", { class: "feed-by" }, "by ", shortId(b.miner)),
    el("span", { class: "feed-age" }, fmtAgo(ageSecs(b.timestamp))),
  );
}

// ---- live transactions ----

function txCard(store: Store): HTMLElement {
  const txs = store.state.recentTx;
  const body =
    txs.length === 0
      ? waiting("Waiting for transactions…")
      : el("div", { class: "feed" }, ...txs.map(txRow));
  return card("Live transactions", body);
}

function txRow(tx: TxEvent): HTMLElement {
  const hasAmount = tx.amount.base !== 0n;
  return el(
    "div",
    { class: "feed-row" },
    el("span", { class: "tx-kind", style: `color:${kindColor(tx.kind)}` }, tx.kind),
    el("span", { class: "feed-mid mono" }, shortId(tx.origin)),
    el(
      "span",
      { class: "feed-amt mono" },
      hasAmount ? fmtCredits(tx.amount) : "—",
    ),
  );
}

/** Colour per tx kind, drawn from the theme accents (teal=earn, violet=move, amber=lifecycle). */
function kindColor(kind: TxKind): string {
  switch (kind) {
    case "UptimeReward":
    case "JobSettle":
    case "Heartbeat":
      return "var(--teal)";
    case "Transfer":
    case "ChannelOpen":
    case "ChannelClose":
      return "var(--violet)";
    case "JobBid":
    case "HostBond":
    case "HostUnbond":
      return "var(--amber)";
    case "SlashEquivocation":
    case "JobExpire":
    case "ChannelExpire":
    case "RevokeCapability":
      return "var(--red)";
    default:
      return "var(--muted)";
  }
}

// ---- capacity leaderboard ----

function leaderboardCard(store: Store): HTMLElement {
  const self = store.selfNodeId;
  const ranked = [...store.state.atlas].sort((a, b) => b.cpuCores - a.cpuCores).slice(0, 12);
  const body =
    ranked.length === 0
      ? waiting("No peers visible yet.")
      : el(
          "table",
          { class: "atlas" },
          el(
            "thead",
            {},
            el("tr", {}, th("#"), th("Node"), th("Cores"), th("Mem"), th("Jobs"), th("Tags")),
          ),
          el("tbody", {}, ...ranked.map((e, i) => leaderRow(e, i + 1, e.nodeId === self))),
        );
  return card("Capacity leaderboard", body, "by cores offered");
}

function leaderRow(e: AtlasEntry, rank: number, isSelf: boolean): HTMLElement {
  return el(
    "tr",
    { class: isSelf ? "self" : "" },
    el("td", {}, String(rank)),
    el(
      "td",
      {},
      shortId(e.nodeId),
      isSelf ? el("span", { style: "color:var(--teal);margin-left:6px" }, "(me)") : null,
    ),
    el("td", {}, String(e.cpuCores)),
    el("td", {}, fmtMem(e.memMb)),
    el("td", {}, String(e.runningJobs)),
    el("td", {}, ...e.tags.map((t) => el("span", { class: `tag ${t === "gpu" ? "gpu" : ""}` }, t))),
  );
}

// ---- helpers ----

function card(title: string, body: HTMLElement, right?: string): HTMLElement {
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h2", {}, title),
      right ? el("div", { class: "right muted-note" }, right) : null,
    ),
    body,
  );
}

function waiting(msg: string): HTMLElement {
  return el("div", { class: "card-body" }, el("div", { class: "empty" }, el("div", {}, msg)));
}

/** Block timestamps are unix seconds; tolerate a millisecond timestamp just in case. */
function ageSecs(ts: number): number {
  const sec = ts > 1e12 ? ts / 1000 : ts;
  return Math.max(0, Date.now() / 1000 - sec);
}

function th(t: string): HTMLElement {
  return el("th", {}, t);
}

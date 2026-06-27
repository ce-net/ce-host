/**
 * Wallet panel — the credit-half money view (PLAN/06-token-management §5).
 *
 * Composes the shared @ce-net/ui `walletPanel` (balance breakdown card + send form + live
 * history table, all driven by the SDK's `Amount` bigint money type — never a float) with a
 * CE-Host-local channels sub-section. Every mutation is a callback the panel hands back to the
 * Store, which fulfils it via `ce.wallet.*`; this file holds no key material and issues no
 * requests of its own beyond what the Store exposes.
 *
 * Data sources (all already in the Store, refreshed on a 15s timer + live SSE prepend):
 *  - balance      → ce.wallet.balance()        (GET /status breakdown)
 *  - txHistory    → ce.wallet.transactions()   (GET /transactions/:self) + live /transactions/stream
 *  - channels     → ce.wallet.listChannels()   (GET /channels)
 *  - onSend       → store.transfer()           (POST /transfer)
 *  - onLoadOlder  → store.loadOlderTx()         (paged GET /transactions/:self?before=)
 *
 * Older node builds that predate GET /transactions/:id (404) flag historyAvailable=false in the
 * Store; we then show an honest note instead of an empty table.
 */

import { Amount } from "@ce-net/sdk";
import type { Channel, TxRecord } from "@ce-net/sdk";
import { walletPanel, fmtCredits, shortId, lineChart } from "@ce-net/ui";
import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { toast } from "../lib/toast.js";

export function renderWallet(store: Store, root: HTMLElement): void {
  const s = store.state;

  // The shared @ce-net/ui panel: balance card + send form + history table. We pass the Store's
  // balance/history straight through (both are SDK types) and wire the callbacks to the Store.
  const panel = walletPanel({
    balance: s.balance,
    history: s.historyAvailable ? s.txHistory : [],
    selfId: store.selfNodeId,
    onSend: async (to: string, amount: Amount) => {
      const txId = await store.transfer(to, amount);
      toast(`Sent ${fmtCredits(amount)} cr (tx ${shortId(txId)})`, "ok");
    },
    onLoadOlder: (beforeHeight: number) => void store.loadOlderTx(beforeHeight),
  });

  const blocks: (HTMLElement | null)[] = [];

  // Cumulative earned vs spent, derived from the itemized history (newest-first → chronological).
  const chart = earningsCard(s.historyAvailable ? s.txHistory : []);
  if (chart) blocks.push(chart);

  blocks.push(panel);

  // Honest note when the node build predates the itemized-history endpoint.
  if (!s.historyAvailable) {
    blocks.push(historyUnavailableNote());
  }

  // Channels sub-section (CE-Host-local, below the shared panel).
  blocks.push(channelsCard(s.channels));

  mount(root, el("div", { class: "view wallet-view" }, ...blocks.filter((b): b is HTMLElement => !!b)));
}

/**
 * "Earned vs spent over time" card: two cumulative series built from the transaction
 * history. Money stays bigint base units into the chart (lineChart normalises with bigint,
 * so a long run of large totals keeps full precision); the y-axis max label is a precise
 * Amount string. Returns null until there are at least two points to draw a trend.
 */
function earningsCard(history: readonly TxRecord[]): HTMLElement | null {
  if (history.length < 2) return null;

  // History is newest-first; walk oldest→newest to accumulate.
  const chrono = [...history].reverse();
  let earned = 0n;
  let spent = 0n;
  const earnedSeries: bigint[] = [];
  const spentSeries: bigint[] = [];
  for (const t of chrono) {
    if (t.direction === "in") earned += t.amount.base;
    else spent += t.amount.base;
    earnedSeries.push(earned);
    spentSeries.push(spent);
  }

  const peak = earned > spent ? earned : spent;
  const chart = lineChart(
    [
      { values: earnedSeries, stroke: "var(--teal)", fill: true, label: "earned" },
      { values: spentSeries, stroke: "var(--violet)", label: "spent" },
    ],
    {
      width: 560,
      height: 150,
      axis: true,
      baselineZero: true,
      label: "cumulative earned vs spent",
      yLabels: { min: "0", max: `${fmtCredits(Amount.fromBaseUnits(peak), 0)} cr` },
    },
  );

  return el(
    "div",
    { class: "ce-card", style: "margin-bottom:14px" },
    el(
      "div",
      { class: "ce-card-head" },
      el("h2", {}, "Earned vs spent"),
      el(
        "div",
        { class: "chart-legend", style: "margin-left:auto" },
        legendDot("var(--teal)", "earned"),
        legendDot("var(--violet)", "spent"),
      ),
    ),
    el("div", { class: "chart-body" }, chart),
  );
}

function legendDot(color: string, label: string): HTMLElement {
  return el(
    "span",
    { class: "leg" },
    el("span", { class: "swatch", style: `background:${color}` }),
    label,
  );
}

function historyUnavailableNote(): HTMLElement {
  return el(
    "div",
    { class: "ce-card", style: "margin-top:14px" },
    el(
      "div",
      { class: "ce-card-body", style: "color:var(--muted)" },
      "Itemized transaction history is unavailable on this node build ",
      "(it predates GET /transactions/:id). Live transfers still appear via the stream; ",
      "restart the node on a current build for full paged history.",
    ),
  );
}

function channelsCard(channels: Channel[]): HTMLElement {
  let body: HTMLElement;
  if (channels.length === 0) {
    body = el(
      "div",
      { class: "ce-card-body", style: "color:var(--muted)" },
      "No open payment channels. Channels lock capacity to stream micropayments (relay pay, ",
      "paid data fetch); open one with the SDK or `ce channel open`.",
    );
  } else {
    const rows = channels.map((c) =>
      el(
        "tr",
        {},
        el("td", { title: c.channelId }, shortId(c.channelId)),
        el("td", { title: c.payer }, shortId(c.payer)),
        el("td", { title: c.host }, shortId(c.host)),
        el("td", { style: "font-family:var(--mono)" }, `${fmtCredits(c.capacity)} cr`),
        el("td", {}, c.expiryHeight > 0 ? String(c.expiryHeight) : "default"),
      ),
    );
    body = el(
      "table",
      { class: "ce-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...["Channel", "Payer", "Host", "Capacity", "Expiry"].map((t) => el("th", {}, t)),
        ),
      ),
      el("tbody", {}, ...rows),
    );
  }

  return el(
    "div",
    { class: "ce-card", style: "margin-top:14px" },
    el("div", { class: "ce-card-head" }, el("h2", {}, "Payment channels")),
    body,
  );
}

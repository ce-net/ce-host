/**
 * Running-jobs table — the torrent-client centerpiece.
 *
 * Each /jobs row { jobId, status, payer, containerId, cost, bid } is joined with:
 *  - elapsed: local first_seen_at (the node row carries no start time)
 *  - cr/min : per-job/host accrual from the transaction stream (best-effort, '—' if none)
 *  - payer  : shortened, click opens a /history/:payer trust mini-card
 *  - kill   : DELETE /jobs/:id with a confirm + economic warning
 *
 * Where a value is genuinely not on the wire (requested cpu/mem for jobs hosted for
 * others), we render '—' rather than fabricate it — honest placeholder per the design.
 */

import type { Job } from "@ce-net/sdk";
import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { fmtCredits, fmtElapsed, shortId } from "../lib/format.js";
import { confirmModal } from "../lib/modal.js";
import { toast } from "../lib/toast.js";

const FILTERS = ["all", "running", "awaiting_settlement", "settled", "failed"] as const;
type Filter = (typeof FILTERS)[number];

let activeFilter: Filter = "all";

export function renderJobs(store: Store, root: HTMLElement): void {
  const s = store.state;

  const filtered = s.jobs.filter((j) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "failed") return j.status.startsWith("failed");
    return j.status === activeFilter;
  });

  const head = el(
    "div",
    { class: "card-head" },
    el("h2", {}, "Running jobs"),
    el(
      "div",
      { class: "right" },
      el(
        "div",
        { class: "filters" },
        ...FILTERS.map((f) =>
          el(
            "button",
            {
              class: `filter ${activeFilter === f ? "active" : ""}`,
              onClick: () => {
                activeFilter = f;
                renderJobs(store, root);
              },
            },
            f.replace(/_/g, " "),
          ),
        ),
      ),
    ),
  );

  let body: HTMLElement;
  if (filtered.length === 0) {
    body = el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "empty" },
        el("div", { class: "big" }, "No jobs running."),
        el(
          "div",
          {},
          "You're online and earning uptime rewards while you wait. Set what you ",
          "offer in ",
          el(
            "a",
            { class: "link", onClick: () => navTo("caps") },
            "Resource caps",
          ),
          ".",
        ),
      ),
    );
  } else {
    const rows = filtered.map((j) => jobRow(store, root, j));
    body = el(
      "table",
      { class: "jobs" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          th("Image"),
          th("Payer"),
          th("CPU/Mem"),
          th("Elapsed"),
          th("Status"),
          th("cr/min"),
          th("Cost / Bid"),
          th("Actions"),
        ),
      ),
      el("tbody", {}, ...rows),
    );
  }

  mount(root, el("div", { class: "card" }, head, body));
}

function jobRow(store: Store, root: HTMLElement, j: Job): HTMLElement {
  const removing = store.state.removing.has(j.jobId);

  // Elapsed from local first-seen (running jobs only).
  const firstSeen = store.state.firstSeen[j.jobId];
  const elapsed =
    j.status === "running" && firstSeen ? fmtElapsed((Date.now() - firstSeen) / 1000) : "—";

  // cr/min: best-effort accrual keyed by this node (we host → our id is the origin).
  const crMin = store.creditsPerMinFor(store.selfNodeId);
  const crMinStr = j.status === "running" && crMin ? fmtCredits(crMin, 2) : "—";

  // requested cpu/mem are not on the /jobs row for jobs hosted for others.
  const cpuMem = "—";

  const cost = j.cost ?? null;
  const bid = j.bid ?? null;
  const costBid =
    (cost ? `${fmtCredits(cost)}` : "—") + " / " + (bid ? `${fmtCredits(bid)}` : "—");

  const statusKey = j.status.startsWith("failed") ? "failed" : j.status;

  const actions =
    j.status === "running"
      ? el(
          "button",
          {
            class: "btn danger sm",
            disabled: removing,
            onClick: () => void killJob(store, root, j),
          },
          removing ? "stopping…" : "kill",
        )
      : el("span", { class: "placeholder" }, "—");

  return el(
    "tr",
    { class: removing ? "removing" : "" },
    td(el("span", { class: "img-cell" }, j.containerId ? imageGuess(j) : imageGuess(j))),
    td(
      j.payer
        ? el(
            "span",
            {
              class: "payer-cell",
              onClick: () => void showPayerCard(store, j.payer!),
            },
            shortId(j.payer),
          )
        : el("span", { class: "placeholder" }, "—"),
    ),
    td(el("span", { class: cpuMem === "—" ? "placeholder" : "" }, cpuMem)),
    td(elapsed),
    td(el("span", { class: `pill ${statusKey}` }, statusKey)),
    td(el("span", { class: crMinStr === "—" ? "placeholder" : "crmin" }, crMinStr)),
    td(costBid),
    td(actions),
  );
}

/**
 * The /jobs row does not surface the image string for jobs hosted for others; we show
 * the container id (short) when present, else the job id, as a stable identifier.
 * (M5's optional GET /jobs/:id/live would carry the true image — TODO once available.)
 */
function imageGuess(j: Job): string {
  if (j.containerId) return shortId(j.containerId);
  return shortId(j.jobId);
}

async function killJob(store: Store, root: HTMLElement, j: Job): Promise<void> {
  const ok = await confirmModal({
    title: "Stop this job?",
    danger: true,
    confirmLabel: "Stop & forfeit",
    body: el(
      "div",
      {},
      el("p", {}, `Stop job ${shortId(j.jobId)} and remove its container.`),
      el(
        "div",
        { class: "warn-box" },
        el("b", {}, "Heads up: "),
        "Killing a running job forfeits any remaining bid for the work not yet ",
        "delivered, and the payer may see an unfinished job in your history. ",
        "Only kill jobs that are stuck or misbehaving.",
      ),
    ),
  });
  if (!ok) return;

  store.state.removing.add(j.jobId);
  renderJobs(store, root);
  try {
    await store.client.kill(j.jobId);
    toast(`Stopped ${shortId(j.jobId)}`, "ok");
  } catch (e) {
    store.state.removing.delete(j.jobId);
    renderJobs(store, root);
    toast(`Kill failed: ${msg(e)}`, "err");
  }
}

async function showPayerCard(store: Store, payer: string): Promise<void> {
  let bodyNode: Node;
  try {
    const h = await store.client.history(payer);
    bodyNode = el(
      "div",
      {},
      kv("Node", shortId(payer)),
      kv("Jobs paid", String(h.jobsPaid)),
      kv("Jobs hosted", String(h.jobsHosted)),
      kv("Expiries", String(h.expiries)),
      kv("Spent", `${fmtCredits(h.spent)} cr`),
      kv("Earned", `${fmtCredits(h.earned)} cr`),
      h.expiries > 0
        ? el(
            "div",
            { class: "warn-box", style: "margin-top:10px" },
            `${h.expiries} expired job(s) on record — a weak trust signal.`,
          )
        : el("div", { class: "advisory", style: "margin-top:10px" }, "Clean history."),
    );
  } catch (e) {
    bodyNode = el("p", {}, `No history available: ${msg(e)}`);
  }
  await confirmModal({
    title: `Payer ${shortId(payer)}`,
    body: bodyNode,
    confirmLabel: "Close",
    cancelLabel: "Copy id",
  }).then((copied) => {
    if (!copied) void navigator.clipboard?.writeText(payer);
  });
}

function kv(k: string, v: string): HTMLElement {
  return el(
    "div",
    { style: "display:flex;justify-content:space-between;padding:4px 0" },
    el("span", { style: "color:var(--faint)" }, k),
    el("span", { style: "font-family:var(--mono)" }, v),
  );
}

function navTo(view: string): void {
  window.dispatchEvent(new CustomEvent("ce-host:nav", { detail: view }));
}

function th(t: string): HTMLElement {
  return el("th", {}, t);
}
function td(child: Node | string): HTMLElement {
  return el("td", {}, typeof child === "string" ? document.createTextNode(child) : child);
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

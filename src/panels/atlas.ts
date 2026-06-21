/**
 * Peers / mesh atlas — who is on the mesh, their capacity and tags.
 * Data: GET /atlas → [{ nodeId, cpuCores, memMb, runningJobs, lastSeenSecs, tags }].
 * Self row highlighted; totals aggregated at the foot.
 */

import type { AtlasEntry } from "@ce-net/sdk";
import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { fmtAgo, fmtMem, shortId } from "../lib/format.js";

export function renderAtlas(store: Store, root: HTMLElement): void {
  const entries = [...store.state.atlas].sort((a, b) => b.cpuCores - a.cpuCores);
  const selfId = store.selfNodeId;

  let table: HTMLElement;
  if (entries.length === 0) {
    table = el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "empty" },
        el("div", { class: "big" }, "No peers visible yet."),
        el(
          "div",
          {},
          "The atlas populates from CEP-1 capacity signals while your node mines. ",
          "Give it a minute after start.",
        ),
      ),
    );
  } else {
    table = el(
      "table",
      { class: "atlas" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          th("Node"),
          th("CPU"),
          th("Mem"),
          th("Jobs"),
          th("Tags"),
          th("Last seen"),
        ),
      ),
      el("tbody", {}, ...entries.map((e) => atlasRow(e, e.nodeId === selfId))),
    );
  }

  const totals = aggregate(entries);
  const foot = el(
    "div",
    { class: "atlas-totals" },
    el("span", {}, el("b", {}, String(totals.peers)), " peers"),
    el("span", {}, el("b", {}, String(totals.cores)), " cores"),
    el("span", {}, el("b", {}, fmtMem(totals.memMb)), " offered"),
    el("span", {}, el("b", {}, String(totals.jobs)), " jobs running"),
    el("span", {}, el("b", {}, String(totals.gpu)), " gpu nodes"),
  );

  mount(
    root,
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h2", {}, "Mesh atlas")),
      table,
      entries.length > 0 ? foot : null,
    ),
  );
}

function atlasRow(e: AtlasEntry, isSelf: boolean): HTMLElement {
  return el(
    "tr",
    { class: isSelf ? "self" : "" },
    el(
      "td",
      {},
      shortId(e.nodeId),
      isSelf ? el("span", { style: "color:var(--teal);margin-left:6px" }, "(me)") : null,
    ),
    el("td", {}, String(e.cpuCores)),
    el("td", {}, fmtMem(e.memMb)),
    el("td", {}, String(e.runningJobs)),
    el(
      "td",
      {},
      ...e.tags.map((t) =>
        el("span", { class: `tag ${t === "gpu" ? "gpu" : ""}` }, t),
      ),
    ),
    el("td", {}, fmtAgo(e.lastSeenSecs)),
  );
}

function aggregate(entries: AtlasEntry[]) {
  return entries.reduce(
    (acc, e) => ({
      peers: acc.peers + 1,
      cores: acc.cores + e.cpuCores,
      memMb: acc.memMb + e.memMb,
      jobs: acc.jobs + e.runningJobs,
      gpu: acc.gpu + (e.tags.includes("gpu") ? 1 : 0),
    }),
    { peers: 0, cores: 0, memMb: 0, jobs: 0, gpu: 0 },
  );
}

function th(t: string): HTMLElement {
  return el("th", {}, t);
}

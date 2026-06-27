/**
 * Network view — how the mesh looks from this node.
 *
 * Two surfaces, both from live `GET /atlas` data (no new endpoints):
 *   1. A radial topology map (the shared `@ce-net/ui` `netGraph`): self at the centre,
 *      peers around it, each disc sized by offered cores and coloured by role (self / gpu
 *      / busy / idle), spokes faded by recency. Honestly "my view of the mesh" — a
 *      hub-and-spoke of who I can currently see, not a claim about peer↔peer links.
 *   2. The dense atlas table (reused from the atlas panel) for the exact numbers.
 *
 * The `netGraph` component already supports a per-node `radial` metric + labelled guide
 * rings, so when the node exposes RTT keyed by CE node id this becomes a true latency
 * sonar with a one-line change here — no faked latency axis today.
 */

import type { AtlasEntry } from "@ce-net/sdk";
import { netGraph, type NetGraphNode } from "@ce-net/ui";
import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { fmtMem, shortId } from "../lib/format.js";
import { renderAtlas } from "./atlas.js";

const W = 720;
const H = 440;

export function renderNetwork(store: Store, root: HTMLElement): void {
  const atlasHost = el("div", {});
  renderAtlas(store, atlasHost);

  mount(
    root,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h2", {}, "Mesh topology"),
        el("div", { class: "right" }, legend()),
      ),
      el("div", { class: "topo-wrap" }, topology(store)),
    ),
    atlasHost,
  );
}

function topology(store: Store): HTMLElement {
  const self = store.selfNodeId;
  const entries = store.state.atlas;

  if (entries.length === 0) {
    return el(
      "div",
      { class: "empty" },
      el("div", { class: "big" }, "The mesh map is empty."),
      el("div", {}, "Peers appear here from CEP-1 capacity signals once your node is mining. Give it a minute."),
    );
  }

  // Deterministic order so a disc keeps its slot across re-renders (no jitter).
  const peers = entries
    .filter((e) => e.nodeId !== self)
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))
    .map((e): NetGraphNode => {
      const gpu = e.tags.includes("gpu");
      const fresh = e.lastSeenSecs <= 90;
      return {
        id: e.nodeId,
        label: shortId(e.nodeId),
        radius: discRadius(e.cpuCores),
        color: gpu ? "var(--violet)" : e.runningJobs > 0 ? "var(--teal-dim)" : "var(--line)",
        stroke: gpu ? "var(--violet)" : "var(--line-2, #28343f)",
        link: fresh ? 0.85 : 0.3,
        title: titleFor(e, false),
      };
    });

  const selfEntry = entries.find((e) => e.nodeId === self);
  const selfNode: NetGraphNode = {
    id: self,
    label: "you",
    radius: discRadius(selfEntry?.cpuCores ?? 4),
    color: "var(--teal)",
    stroke: "var(--teal)",
    title: titleFor(selfEntry ?? blankSelf(self), true),
  };

  const svg = netGraph({ self: selfNode, nodes: peers }, { width: W, height: H, label: "mesh topology" });
  return svg as unknown as HTMLElement;
}

function discRadius(cores: number): number {
  return Math.min(22, 7 + Math.sqrt(Math.max(cores, 0)) * 3.4);
}

function blankSelf(id: string): AtlasEntry {
  return { nodeId: id, cpuCores: 0, memMb: 0, runningJobs: 0, lastSeenSecs: 0, tags: [] };
}

function titleFor(e: AtlasEntry, isSelf: boolean): string {
  const who = isSelf ? "you" : shortId(e.nodeId);
  return `${who}  ·  ${e.cpuCores} cores  ·  ${fmtMem(e.memMb)}  ·  ${e.runningJobs} jobs${e.tags.length ? `  ·  ${e.tags.join(", ")}` : ""}`;
}

function legend(): HTMLElement {
  return el(
    "div",
    { class: "topo-legend" },
    dot("var(--teal)", "you"),
    dot("var(--violet)", "gpu"),
    dot("var(--teal-dim)", "busy"),
    dot("var(--line)", "idle"),
  );
}

function dot(color: string, label: string): HTMLElement {
  return el(
    "span",
    { class: "leg" },
    el("span", { class: "swatch", style: `background:${color}` }),
    label,
  );
}

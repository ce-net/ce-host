/**
 * Network view — how the mesh looks from this node.
 *
 * Two surfaces, both from live `GET /atlas` data (no new endpoints):
 *   1. A radial topology map: self at the centre, peers placed evenly around it,
 *      each disc sized by offered cores and coloured by role (self / gpu / busy /
 *      idle). Edges run centre→peer — this is honestly "my view of the mesh", a
 *      hub-and-spoke of who I can currently see, not a claim about peer↔peer links.
 *   2. The dense atlas table (reused from the atlas panel) for the exact numbers.
 *
 * Phase 2 upgrades the map with real RTT (latency as radius, the ce-net.com sonar)
 * once the node exposes per-node-id round-trip times; today's atlas carries capacity
 * + recency but not RTT keyed by CE node id, so we do not fake a latency axis.
 */

import type { AtlasEntry } from "@ce-net/sdk";
import type { Store } from "../stores/store.js";
import { el, mount, svgEl } from "../lib/dom.js";
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
  const entries = [...store.state.atlas];
  // Deterministic order so a disc keeps its slot across re-renders (no jitter).
  const peers = entries.filter((e) => e.nodeId !== self).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));

  if (entries.length === 0) {
    return el(
      "div",
      { class: "empty" },
      el("div", { class: "big" }, "The mesh map is empty."),
      el("div", {}, "Peers appear here from CEP-1 capacity signals once your node is mining. Give it a minute."),
    );
  }

  const cx = W / 2;
  const cy = H / 2;
  const baseR = Math.min(W, H) * 0.36;
  const n = Math.max(peers.length, 1);

  const edges: SVGElement[] = [];
  const discs: SVGElement[] = [];

  peers.forEach((e, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    // Alternate two rings when crowded so discs do not collide.
    const r = baseR * (peers.length > 9 && i % 2 === 1 ? 0.66 : 1);
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    const fresh = e.lastSeenSecs <= 90;

    edges.push(
      svgEl("line", {
        x1: cx,
        y1: cy,
        x2: x,
        y2: y,
        stroke: fresh ? "#2c8d7a" : "#1d2733",
        "stroke-width": 1,
        "stroke-opacity": fresh ? 0.6 : 0.3,
      }),
    );
    discs.push(disc(e, x, y, false));
  });

  // Self last so it paints on top of the edges.
  const selfEntry = entries.find((e) => e.nodeId === self);
  const selfDisc = disc(
    selfEntry ?? { nodeId: self, cpuCores: 0, memMb: 0, runningJobs: 0, lastSeenSecs: 0, tags: [] },
    cx,
    cy,
    true,
  );

  const svg = svgEl(
    "svg",
    { viewBox: `0 0 ${W} ${H}`, class: "topo", preserveAspectRatio: "xMidYMid meet" },
    ...edges,
    ...discs,
    selfDisc,
  );
  return svg as unknown as HTMLElement;
}

function disc(e: AtlasEntry, x: number, y: number, isSelf: boolean): SVGElement {
  const radius = Math.min(22, 7 + Math.sqrt(Math.max(e.cpuCores, 0)) * 3.4);
  const gpu = e.tags.includes("gpu");
  const fill = isSelf
    ? "#50e3c2"
    : gpu
      ? "#9d7bff"
      : e.runningJobs > 0
        ? "#2c8d7a"
        : "#1d2733";
  const stroke = isSelf ? "#50e3c2" : gpu ? "#9d7bff" : "#28343f";

  const g = svgEl("g", { class: "node" }, svgEl("title", {}, titleFor(e, isSelf)));
  if (isSelf) {
    g.append(svgEl("circle", { cx: x, cy: y, r: radius + 6, fill: "none", stroke: "#50e3c2", "stroke-opacity": 0.25, "stroke-width": 2 }));
  }
  g.append(
    svgEl("circle", {
      cx: x,
      cy: y,
      r: radius,
      fill,
      "fill-opacity": isSelf ? 0.9 : 0.85,
      stroke,
      "stroke-width": 1.5,
    }),
  );
  g.append(
    svgEl(
      "text",
      { x, y: y + radius + 13, "text-anchor": "middle", class: "topo-label", fill: isSelf ? "#50e3c2" : "#8a97a6" },
      isSelf ? "you" : shortId(e.nodeId),
    ),
  );
  return g;
}

function titleFor(e: AtlasEntry, isSelf: boolean): string {
  const who = isSelf ? "you" : shortId(e.nodeId);
  return `${who}  ·  ${e.cpuCores} cores  ·  ${fmtMem(e.memMb)}  ·  ${e.runningJobs} jobs${e.tags.length ? `  ·  ${e.tags.join(", ")}` : ""}`;
}

function legend(): HTMLElement {
  return el(
    "div",
    { class: "topo-legend" },
    dot("#50e3c2", "you"),
    dot("#9d7bff", "gpu"),
    dot("#2c8d7a", "busy"),
    dot("#1d2733", "idle"),
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

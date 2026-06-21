/** Minimal toast notifications. */

import { el } from "./dom.js";

let host: HTMLElement | null = null;

function container(): HTMLElement {
  if (!host) {
    host = el("div", { class: "toasts" });
    document.body.append(host);
  }
  return host;
}

export type ToastKind = "ok" | "err" | "warn";

export function toast(message: string, kind: ToastKind = "ok", ttlMs = 4200): void {
  const node = el("div", { class: `toast ${kind}` }, message);
  container().append(node);
  setTimeout(() => {
    node.style.transition = "opacity 0.25s";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 260);
  }, ttlMs);
}

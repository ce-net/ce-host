/** Tiny DOM helpers — no framework. Keeps the bundle minimal and the panels explicit. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Create an element with attributes/handlers and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      node.className = String(v);
    } else if (k === "html") {
      node.innerHTML = String(v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** Replace all children of `parent` with `nodes`. */
export function mount(parent: HTMLElement, ...nodes: (Node | null | undefined)[]): void {
  parent.replaceChildren(...nodes.filter((n): n is Node => !!n));
}

/** Clear a node. */
export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

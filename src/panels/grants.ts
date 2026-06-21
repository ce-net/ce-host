/**
 * Capability grants.
 *
 * "Granted by me" is an app-local log: CE has no endpoint listing capabilities a node
 * issued (tokens live with the grantee). We record grants made *through this UI* and
 * let the operator copy the token or revoke it. Revoke → POST /capabilities/revoke
 * { nonce }; the on-chain revoked set comes from GET /capabilities/revoked.
 *
 * Issuing a real capability requires the node's signing key (the `ce grant` CLI / the
 * Tauri supervisor). In the web tier we record a grant the operator pastes/created out
 * of band; the Tauri shell will wire the issue button to the supervisor. Marked TODO.
 */

import type { Store } from "../stores/store.js";
import { el, mount } from "../lib/dom.js";
import { confirmModal } from "../lib/modal.js";
import { toast } from "../lib/toast.js";
import { loadConfig, saveConfig, type IssuedGrant } from "../lib/config.js";
import { shortId } from "../lib/format.js";

export function renderGrants(store: Store, root: HTMLElement): void {
  const cfg = loadConfig();
  const grants = cfg.grants;

  const issuedSection =
    grants.length === 0
      ? el(
          "div",
          { class: "empty", style: "padding:24px" },
          el("div", { class: "big" }, "No grants recorded."),
          el(
            "div",
            {},
            "Capabilities you issue through this dashboard appear here so you can ",
            "copy or revoke them.",
          ),
        )
      : el("div", {}, ...grants.map((g) => grantRow(store, g)));

  const revokedRows =
    store.state.revoked.length === 0
      ? el("div", { class: "advisory" }, "No revocations on-chain.")
      : el(
          "div",
          {},
          ...store.state.revoked.map((r) =>
            el(
              "div",
              { class: "grant-row" },
              el(
                "span",
                { class: "meta" },
                `issuer ${shortId(r.issuer)}  nonce ${r.nonce}`,
              ),
              el("span", { class: "pill settled", style: "margin-left:auto" }, "revoked"),
            ),
          ),
        );

  mount(
    root,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h2", {}, "Capabilities"),
        el(
          "div",
          { class: "right" },
          el(
            "button",
            { class: "btn sm", onClick: () => void recordGrant(store, root) },
            "+ record grant",
          ),
        ),
      ),
      el(
        "div",
        { class: "card-body" },
        el("div", { class: "section-label" }, "Granted by me (local log)"),
        issuedSection,
        el("div", { class: "section-label", style: "margin-top:18px" }, "Revoked (on-chain)"),
        revokedRows,
      ),
    ),
  );
}

function grantRow(store: Store, g: IssuedGrant): HTMLElement {
  const revokedOnChain = store.state.revoked.some((r) => r.nonce === g.nonce);
  return el(
    "div",
    { class: "grant-row" },
    el(
      "div",
      {},
      el("span", { class: "grantee" }, `→ ${shortId(g.grantee)}`),
      el("div", { class: "abilities" }, "can: " + g.abilities.join(",")),
      el(
        "div",
        { class: "meta" },
        `nonce ${g.nonce}` + (g.expires ? `  exp ${g.expires}` : ""),
      ),
    ),
    el(
      "div",
      { class: "actions" },
      revokedOnChain
        ? el("span", { class: "pill settled" }, "revoked")
        : el(
            "button",
            {
              class: "btn sm ghost",
              onClick: () => {
                void navigator.clipboard?.writeText(g.token);
                toast("Token copied", "ok");
              },
            },
            "copy token",
          ),
      revokedOnChain
        ? null
        : el(
            "button",
            { class: "btn sm danger", onClick: () => void revokeGrant(store, g) },
            "revoke",
          ),
    ),
  );
}

async function revokeGrant(store: Store, g: IssuedGrant): Promise<void> {
  const ok = await confirmModal({
    title: "Revoke capability?",
    danger: true,
    confirmLabel: "Revoke",
    body: el(
      "div",
      {},
      el("p", {}, `Revoke grant to ${shortId(g.grantee)} (can: ${g.abilities.join(",")}).`),
      el(
        "div",
        { class: "warn-box" },
        "This submits an on-chain RevokeCapability tx. The grantee — and anyone they ",
        "delegated to — loses these abilities once it is mined (~a minute). This cannot ",
        "be undone; you would have to issue a fresh grant.",
      ),
    ),
  });
  if (!ok) return;
  try {
    const txId = await store.client.capabilities.revoke(g.nonce);
    toast(`Revoke submitted (${shortId(txId)})`, "ok");
  } catch (e) {
    toast(`Revoke failed: ${msg(e)}`, "err");
  }
}

/**
 * Record a grant made out of band (e.g. via `ce grant`). The Tauri shell will replace
 * this with a real issue flow through the supervisor + node signing key. TODO(tauri).
 */
async function recordGrant(store: Store, root: HTMLElement): Promise<void> {
  const grantee = el("input", { class: "cap-input", style: "width:100%", placeholder: "grantee node id (64-hex)" });
  const abilities = el("input", { class: "cap-input", style: "width:100%", placeholder: "abilities, comma-separated (exec,sync,tunnel)" });
  const nonce = el("input", { class: "cap-input", style: "width:100%", type: "number", placeholder: "nonce" });
  const expires = el("input", { class: "cap-input", style: "width:100%", type: "date" });
  const token = el("input", { class: "cap-input", style: "width:100%", placeholder: "capability token (from `ce grant`)" });

  const form = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:8px" },
    field("Grantee", grantee),
    field("Abilities", abilities),
    field("Nonce", nonce),
    field("Expires", expires),
    field("Token", token),
  );

  const ok = await confirmModal({
    title: "Record an issued grant",
    body: form,
    confirmLabel: "Save to log",
  });
  if (!ok) return;

  const gid = (grantee.value || "").trim();
  const ab = (abilities.value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const non = Number(nonce.value);
  if (!gid || ab.length === 0 || !Number.isFinite(non)) {
    toast("Grantee, abilities and nonce are required.", "err");
    return;
  }
  const cfg = loadConfig();
  const entry: IssuedGrant = {
    grantee: gid,
    abilities: ab,
    nonce: non,
    token: (token.value || "").trim(),
    issuedAt: Date.now(),
    ...(expires.value ? { expires: expires.value } : {}),
  };
  saveConfig({ grants: [entry, ...cfg.grants] });
  toast("Grant recorded.", "ok");
  renderGrants(store, root);
}

function field(label: string, input: HTMLElement): HTMLElement {
  return el(
    "label",
    { style: "display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--faint)" },
    label,
    input,
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

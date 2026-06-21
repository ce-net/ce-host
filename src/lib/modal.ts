/** A promise-based confirm modal (used for kill / revoke / drain confirmations). */

import { el } from "./dom.js";

export interface ConfirmOpts {
  title: string;
  body: Node | string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Show a modal; resolves true on confirm, false on cancel/backdrop. */
export function confirmModal(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => {
      back.remove();
      resolve(v);
    };
    const confirmBtn = el(
      "button",
      {
        class: `btn ${opts.danger ? "danger" : "primary"}`,
        onClick: () => close(true),
      },
      opts.confirmLabel ?? "Confirm",
    );
    const cancelBtn = el(
      "button",
      { class: "btn ghost", onClick: () => close(false) },
      opts.cancelLabel ?? "Cancel",
    );
    const modal = el(
      "div",
      { class: "modal" },
      el("h3", {}, opts.title),
      el("div", { class: "body" }, opts.body),
      el("div", { class: "foot" }, cancelBtn, confirmBtn),
    );
    const back = el(
      "div",
      {
        class: "modal-back",
        onClick: (e: Event) => {
          if (e.target === back) close(false);
        },
      },
      modal,
    );
    document.body.append(back);
    confirmBtn.focus();
  });
}

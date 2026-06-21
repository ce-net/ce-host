/**
 * Display formatters. Money stays an {@link Amount} (bigint base units) end to end;
 * we only ever format for display here, never parse a credit value back into a float.
 */

import { Amount } from "@ce-net/sdk";

/** Short node-id form: first 4 + last 4 hex chars, e.g. `7f3a…be45`. */
export function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * Credits formatted for the header/table with grouping and fixed precision.
 * Operates on the bigint base units, never on a JS float.
 */
export function fmtCredits(a: Amount, dp = 2): string {
  const neg = a.isNegative();
  const base = neg ? -a.base : a.base;
  const CREDIT = 1_000_000_000_000_000_000n;
  const whole = base / CREDIT;
  const frac = base % CREDIT;
  // Round the fractional part to `dp` places using integer math.
  const scale = 10n ** BigInt(dp);
  let scaledFrac = (frac * scale) / CREDIT;
  let carryWhole = whole;
  // No rounding-up carry needed beyond truncation here (display only).
  const wholeStr = group(carryWhole.toString());
  const fracStr = dp > 0 ? "." + scaledFrac.toString().padStart(dp, "0") : "";
  return `${neg ? "-" : ""}${wholeStr}${fracStr}`;
}

/** Insert thousands separators into an integer string. */
function group(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Share ratio earned/spent as a float for display only (lossy, never money math). */
export function ratio(earned: Amount, spent: Amount): number {
  const denom = spent.base <= 0n ? 1n : spent.base;
  // Scale to keep two decimals of resolution without floats in the division step.
  const scaled = (earned.base * 100n) / denom;
  return Number(scaled) / 100;
}

/** Format a duration in seconds as `Dd HHh` / `HH:MM:SS`. */
export function fmtElapsed(secs: number): string {
  if (secs < 0 || !Number.isFinite(secs)) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${pad(h)}h`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Uptime as a coarse `Dd HHh MMm`. */
export function fmtUptime(secs: number): string {
  if (secs < 0 || !Number.isFinite(secs)) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** `512MB` / `8GB` from megabytes. */
export function fmtMem(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return Number.isInteger(gb) ? `${gb}GB` : `${gb.toFixed(1)}GB`;
  }
  return `${mb}MB`;
}

/** Seconds-ago to a compact "12s" / "3m" / "now". */
export function fmtAgo(secs: number): string {
  if (secs < 2) return "now";
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

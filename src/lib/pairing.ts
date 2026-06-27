/**
 * Device pairing payloads — how a phone (or any companion shell) is pointed at a node it
 * does not run locally.
 *
 * A mobile / browser companion cannot install or supervise `ce`; it talks to a node you
 * already run (your laptop/desktop/relay) reached over the network. Pairing carries the two
 * facts it needs — the node's base URL and a capability token — in one copy-pasteable (or
 * QR-able) string, matching ce-fleet's token model (the token IS the grant; no codes).
 *
 * Format: `ce-pair:<base64url(JSON {"u": baseUrl, "t"?: token})>`. The parser is tolerant —
 * it also accepts a bare node URL (no token → read-only) or a raw JSON object — so a human
 * can paste whatever they have. Nothing here is consensus state; it only configures the
 * client transport. The token is a normal capability the node already verifies.
 */

export interface Pairing {
  baseUrl: string;
  token?: string;
}

const PREFIX = "ce-pair:";

/** Encode a pairing into the shareable `ce-pair:` string. */
export function encodePairing(p: Pairing): string {
  const obj: { u: string; t?: string } = { u: p.baseUrl };
  if (p.token) obj.t = p.token;
  return PREFIX + b64urlEncode(JSON.stringify(obj));
}

/**
 * Parse a pasted pairing string. Accepts, in order: a `ce-pair:` payload, a bare http(s)
 * URL, or a raw JSON object `{ "u"|"baseUrl", "t"|"token" }`. Returns null if nothing
 * usable (no base URL) can be recovered.
 */
export function parsePairing(input: string): Pairing | null {
  const text = input.trim();
  if (!text) return null;

  if (text.startsWith(PREFIX)) {
    try {
      const json = b64urlDecode(text.slice(PREFIX.length));
      return fromObject(JSON.parse(json));
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(text)) {
    return { baseUrl: stripTrailingSlash(text) };
  }

  try {
    return fromObject(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---- internals ----

function fromObject(o: unknown): Pairing | null {
  if (typeof o !== "object" || o === null) return null;
  const rec = o as Record<string, unknown>;
  const url = pickString(rec["u"]) ?? pickString(rec["baseUrl"]) ?? pickString(rec["url"]);
  if (!url) return null;
  const token = pickString(rec["t"]) ?? pickString(rec["token"]);
  const out: Pairing = { baseUrl: stripTrailingSlash(url) };
  if (token) out.token = token;
  return out;
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** base64url encode a UTF-8 string (browser `btoa`, URL-safe alphabet, no padding). */
function b64urlEncode(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of {@link b64urlEncode}. */
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(b64)));
}

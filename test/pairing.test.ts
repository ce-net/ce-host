import { describe, it, expect } from "vitest";
import { encodePairing, parsePairing } from "../src/lib/pairing.js";

describe("pairing payloads", () => {
  it("round-trips a base URL + token", () => {
    const enc = encodePairing({ baseUrl: "https://node.example:8844", token: "cap-abc" });
    expect(enc.startsWith("ce-pair:")).toBe(true);
    const p = parsePairing(enc);
    expect(p).toEqual({ baseUrl: "https://node.example:8844", token: "cap-abc" });
  });

  it("round-trips a URL with no token", () => {
    const enc = encodePairing({ baseUrl: "https://node.example" });
    const p = parsePairing(enc);
    expect(p).toEqual({ baseUrl: "https://node.example" });
  });

  it("accepts a bare http(s) URL and strips a trailing slash", () => {
    expect(parsePairing("https://relay.ce-net.com/")).toEqual({
      baseUrl: "https://relay.ce-net.com",
    });
  });

  it("accepts a raw JSON object with short or long keys", () => {
    expect(parsePairing('{"u":"https://a.example","t":"tok"}')).toEqual({
      baseUrl: "https://a.example",
      token: "tok",
    });
    expect(parsePairing('{"baseUrl":"https://b.example","token":"t2"}')).toEqual({
      baseUrl: "https://b.example",
      token: "t2",
    });
  });

  it("returns null for unusable input", () => {
    expect(parsePairing("")).toBeNull();
    expect(parsePairing("   ")).toBeNull();
    expect(parsePairing("not a url or payload")).toBeNull();
    expect(parsePairing("ce-pair:!!!not-base64!!!")).toBeNull();
    expect(parsePairing('{"nope":1}')).toBeNull();
  });

  it("handles unicode tokens via base64url", () => {
    const enc = encodePairing({ baseUrl: "https://x.example", token: "tök-✓-é" });
    expect(parsePairing(enc)).toEqual({ baseUrl: "https://x.example", token: "tök-✓-é" });
  });
});

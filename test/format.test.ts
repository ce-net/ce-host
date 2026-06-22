import { describe, it, expect } from "vitest";
import { Amount } from "@ce-net/sdk";
import {
  shortId,
  fmtCredits,
  ratio,
  fmtElapsed,
  fmtUptime,
  fmtMem,
  fmtAgo,
} from "../src/lib/format.js";

describe("fmtCredits", () => {
  it("groups + fixes 2 decimals on bigint base units", () => {
    expect(fmtCredits(Amount.fromCredits("12840.21"))).toBe("12,840.21");
    expect(fmtCredits(Amount.fromCredits("1000"))).toBe("1,000.00");
  });
  it("truncates display precision", () => {
    expect(fmtCredits(Amount.fromCredits("1.239"), 2)).toBe("1.23");
  });
  it("formats negatives", () => {
    expect(fmtCredits(Amount.fromBaseUnits("-2500000000000000000"))).toBe("-2.50");
  });
  it("is exact past Number.MAX_SAFE_INTEGER (supply-cap scale)", () => {
    const cap = Amount.fromCredits("21000000000");
    expect(fmtCredits(cap)).toBe("21,000,000,000.00");
  });
});

describe("ratio", () => {
  it("computes 2-decimal earned/spent", () => {
    expect(ratio(Amount.fromCredits("3"), Amount.fromCredits("2"))).toBe(1.5);
  });
  it("avoids divide-by-zero when nothing has been spent (denominator clamps to 1 base unit)", () => {
    // ce-host's ratio() clamps the denominator to 1 base unit rather than returning Infinity;
    // the resulting number is large but finite, so the UI never renders NaN/Infinity.
    const r = ratio(Amount.fromCredits("5"), Amount.ZERO);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThan(0);
  });
});

describe("time / size", () => {
  it("shortId", () => {
    expect(shortId("7f3aaaaaaaaaabe45")).toBe("7f3a…be45");
    expect(shortId("short")).toBe("short");
  });
  it("fmtElapsed", () => {
    expect(fmtElapsed(3661)).toBe("01:01:01");
    expect(fmtElapsed(90000)).toBe("1d 01h");
    expect(fmtElapsed(-1)).toBe("—");
  });
  it("fmtUptime", () => {
    expect(fmtUptime(59)).toBe("0m");
    expect(fmtUptime(3700)).toBe("1h 1m");
    expect(fmtUptime(90000)).toBe("1d 1h");
  });
  it("fmtMem", () => {
    expect(fmtMem(512)).toBe("512MB");
    expect(fmtMem(2048)).toBe("2GB");
    expect(fmtMem(1536)).toBe("1.5GB");
  });
  it("fmtAgo", () => {
    expect(fmtAgo(1)).toBe("now");
    expect(fmtAgo(45)).toBe("45s");
    expect(fmtAgo(120)).toBe("2m");
    expect(fmtAgo(7200)).toBe("2h");
  });
});

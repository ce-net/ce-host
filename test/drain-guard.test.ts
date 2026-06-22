import { describe, it, expect } from "vitest";
import { drainModeFor, restoreCores, withinWindow } from "../src/panels/caps.js";
import type { CapsConfig } from "../src/lib/config.js";

describe("graceful-drain pause guard", () => {
  it("pausing with running jobs drains (never jumps straight to paused)", () => {
    expect(drainModeFor(1)).toBe("draining");
    expect(drainModeFor(7)).toBe("draining");
  });
  it("pausing an empty host pauses immediately", () => {
    expect(drainModeFor(0)).toBe("paused");
  });
});

describe("restoreCores on resume", () => {
  it("restores to half system cores (min 1) when the cap was zeroed by a pause", () => {
    expect(restoreCores(0, 8)).toBe(4);
    expect(restoreCores(0, 1)).toBe(1);
    expect(restoreCores(0, 3)).toBe(1); // floor(3/2)=1
  });
  it("keeps the user's existing cap when not zeroed", () => {
    expect(restoreCores(6, 16)).toBe(6);
    expect(restoreCores(2, 8)).toBe(2);
  });
});

describe("withinWindow scheduler", () => {
  const sched = (start: string, end: string): CapsConfig["scheduler"] => ({
    mode: "window",
    windowStart: start,
    windowEnd: end,
    pauseOnBattery: false,
  });
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m, 0);

  it("same start/end means always on", () => {
    expect(withinWindow(sched("09:00", "09:00"), at(3))).toBe(true);
  });
  it("daytime window [09:00,17:00)", () => {
    expect(withinWindow(sched("09:00", "17:00"), at(12))).toBe(true);
    expect(withinWindow(sched("09:00", "17:00"), at(8, 59))).toBe(false);
    expect(withinWindow(sched("09:00", "17:00"), at(17))).toBe(false); // end exclusive
  });
  it("overnight window [22:00,08:00) wraps midnight", () => {
    expect(withinWindow(sched("22:00", "08:00"), at(23))).toBe(true);
    expect(withinWindow(sched("22:00", "08:00"), at(2))).toBe(true);
    expect(withinWindow(sched("22:00", "08:00"), at(12))).toBe(false);
  });
});

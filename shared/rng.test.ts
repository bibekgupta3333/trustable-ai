import { describe, it, expect } from "vitest";
import { mulberry32 } from "./rng";

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it("differs between seeds", () => {
    const a = mulberry32(1), b = mulberry32(2);
    const xs = Array.from({ length: 10 }, () => a());
    const ys = Array.from({ length: 10 }, () => b());
    expect(xs).not.toEqual(ys);
  });
  it("returns values in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 10000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it("is roughly uniform", () => {
    const r = mulberry32(123);
    const bins = new Array(10).fill(0);
    for (let i = 0; i < 100000; i++) bins[Math.floor(r() * 10)]++;
    for (const b of bins) expect(Math.abs(b - 10000)).toBeLessThan(500);
  });
  it("matches the reference mulberry32 output for seed 1", () => {
    // Reference value from the canonical mulberry32 implementation.
    expect(mulberry32(1)()).toBeCloseTo(0.6270739405881613, 12);
  });
});

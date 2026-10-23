import { describe, expect, it } from "vitest";
import { bottomOffset, nextScrollFollow } from "./scroll-follow";

const initial = { following: true, previousOffset: 800, previousContentHeight: 1200 };

describe("scroll follow", () => {
  it("uses the real content height for the bottom offset", () => {
    expect(bottomOffset(1200, 400)).toBe(800);
    expect(bottomOffset(300, 400)).toBe(0);
  });

  it("does not treat a shrink clamp as a user scroll", () => {
    const result = nextScrollFollow({
      state: initial,
      sample: { offset: 700, contentHeight: 1100, viewportHeight: 400 },
      programmaticTarget: 700,
    });

    expect(result.following).toBe(true);
    expect(result.jumpVisible).toBe(false);
    expect(result.programmaticHandled).toBe(true);
  });

  it("does not let a stale programmatic target swallow a real up-scroll", () => {
    const result = nextScrollFollow({
      state: initial,
      sample: { offset: 760, contentHeight: 1200, viewportHeight: 400 },
      programmaticTarget: 760,
    });

    expect(result.following).toBe(false);
    expect(result.jumpVisible).toBe(true);
    expect(result.programmaticHandled).toBe(false);
  });

  it("still stops following on a real upward scroll", () => {
    const result = nextScrollFollow({
      state: initial,
      sample: { offset: 760, contentHeight: 1200, viewportHeight: 400 },
      programmaticTarget: null,
    });

    expect(result.following).toBe(false);
    expect(result.jumpVisible).toBe(true);
  });

  it("re-attaches when the user scrolls back near the bottom", () => {
    const result = nextScrollFollow({
      state: { following: false, previousOffset: 500, previousContentHeight: 1200 },
      sample: { offset: 780, contentHeight: 1200, viewportHeight: 400 },
      programmaticTarget: null,
    });

    expect(result.following).toBe(true);
    expect(result.jumpVisible).toBe(false);
  });

  it("still stops following when a user scrolls up during content shrink", () => {
    const result = nextScrollFollow({
      state: initial,
      sample: { offset: 650, contentHeight: 1100, viewportHeight: 400 },
      programmaticTarget: null,
    });

    expect(result.following).toBe(false);
    expect(result.jumpVisible).toBe(true);
  });

  it("ignores scroll-position changes caused by height shrinking", () => {
    const result = nextScrollFollow({
      state: initial,
      sample: { offset: 700, contentHeight: 1100, viewportHeight: 400 },
      programmaticTarget: null,
    });

    expect(result.following).toBe(true);
    expect(result.jumpVisible).toBe(false);
  });
});

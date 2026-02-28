import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "../lib/sql-like";

describe("escapeLikePattern", () => {
  it("会转义 %, _ 以及转义符本身", () => {
    expect(escapeLikePattern("%")).toBe("!%");
    expect(escapeLikePattern("_")).toBe("!_");
    expect(escapeLikePattern("!")).toBe("!!");
    expect(escapeLikePattern("a%b_c!d")).toBe("a!%b!_c!!d");
  });
});


import { describe, expect, it } from "vitest";
import { inlineCall } from "./inline.ts";

describe("inlineCall", () => {
  it("prints a call to the function with its args, minus indents and comment lines", () => {
    function add(a: number, b: number): number {
      // a whole line comment goes
      const url = "https://example.com/a"; // a trailing comment stays, and is harmless
      return a + b + url.length;
    }
    const code = inlineCall(add, "1", "2");
    expect(code.startsWith("(function add(")).toBe(true);
    expect(code.endsWith(")(1,2);")).toBe(true);
    expect(code).not.toContain("a whole line comment goes");
    expect(code).toContain('"https://example.com/a"');
    expect(code).not.toMatch(/^\s/m);
    expect(new Function(`return ${code.slice(0, -1)}`)()).toBe(24);
  });
});

import { describe, expect, it } from "vitest";
import { inlineCall } from "./inline.ts";

describe("inlineCall", () => {
  it("prints a minified call to the function with its args, with no comments", () => {
    function add(a: number, b: number): number {
      // a whole line comment goes
      const url = "https://example.com/a"; // a trailing comment goes too
      return a + b + url.length;
    }
    const code = inlineCall(add, "1", "2");
    expect(code).toMatch(/^\(function \w*\(/);
    expect(code.endsWith(")(1,2);")).toBe(true);
    expect(code).not.toContain("comment goes");
    expect(code).toContain('"https://example.com/a"');
    expect(code).not.toContain("\n");
    expect(new Function(`return ${code.slice(0, -1)}`)()).toBe(24);
  });

  it("keeps a multi line string intact", () => {
    function text(): string {
      return `one
  two`;
    }
    expect(new Function(`return ${inlineCall(text).slice(0, -1)}`)()).toBe("one\n  two");
  });
});

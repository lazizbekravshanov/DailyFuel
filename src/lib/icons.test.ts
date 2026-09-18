import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, iconBody, iconFile } from "./icons.ts";

const dir = fileURLToPath(new URL("../icons/", import.meta.url));

describe("icon set", () => {
  it("has a file for every name and a name for every file", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, "")).sort();
    expect(files).toEqual([...ICON_NAMES].sort());
  });

  for (const name of ICON_NAMES) {
    describe(name, () => {
      const file = iconFile(name)!;

      it("exists", () => {
        expect(file).toBeTypeOf("string");
        expect(file.length).toBeGreaterThan(0);
      });

      it("draws on the 24 by 24 grid with no fixed size", () => {
        const tag = /<svg\b[^>]*>/.exec(file)![0];
        expect(tag).toContain('viewBox="0 0 24 24"');
        expect(tag).not.toMatch(/\s(width|height)=/);
      });

      it("fills with currentColor and nothing else", () => {
        expect(file).toContain('fill="currentColor"');
        const colors = [...file.matchAll(/(?:fill|stroke|stop-color|color)\s*[=:]\s*"?([^";\s>]+)/g)].map((m) => m[1]);
        expect(colors.length).toBeGreaterThan(0);
        for (const c of colors) expect(c).toBe("currentColor");
        // no hex, rgb or named color hiding anywhere else, like a style attribute
        expect(file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(file).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/i);
        expect(file).not.toMatch(/\b(white|black)\b/i);
        expect(file).not.toMatch(/<(rect|style|image|use)\b/);
      });

      it("inlines as paths only", () => {
        const body = iconBody(name);
        expect(body).toMatch(/^<path\b/);
        expect(body).not.toContain("<svg");
        expect(body.replace(/<path\b[^>]*\/>/g, "").trim()).toBe("");
      });
    });
  }

  it("refuses a name it doesn't have", () => {
    // @ts-expect-error not an icon name
    expect(() => iconBody("gas-can")).toThrow(/No icon/);
  });
});

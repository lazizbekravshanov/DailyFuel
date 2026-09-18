// Turns a typed, tested function into an inline <script> body that calls it:
// `(function n(a,b){...})(args);`. The function must stand alone, with no
// imports and no helpers from outside its body. esbuild (it comes with Astro)
// strips the comments and whitespace and shortens local names, like the ?raw
// page scripts in astro.config.mjs. Syntax minifying stays off: it can drop a
// call it thinks has no effect, and this call is the whole script.

import { transformSync } from "esbuild";

export function inlineCall(fn: (...args: never[]) => unknown, ...args: string[]): string {
  const { code } = transformSync(`(${String(fn)})(${args.join(",")});`, {
    loader: "js",
    minifyWhitespace: true,
    minifyIdentifiers: true,
    target: "es2017",
    legalComments: "none",
  });
  return code.trim();
}

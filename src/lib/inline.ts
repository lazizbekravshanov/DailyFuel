// Turns a typed, tested function into an inline <script> body that calls it:
// `(function name(a, b) { ... })(args);`. The function must stand alone, with
// no imports and no helpers from outside its body, and must not hold a
// multi line string, since every line is trimmed. Indents and whole line
// comments are dropped, which is all the shrinking a script this small needs.

export function inlineCall(fn: (...args: never[]) => unknown, ...args: string[]): string {
  const body = String(fn)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .join("\n");
  return `(${body})(${args.join(",")});`;
}

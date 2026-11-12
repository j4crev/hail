import { validatePayload } from "@racrproto/codec";
import { describe, expect, it } from "vitest";
import { BridgeInputError, convertEmail } from "../src/index.js";

/** Deterministic generator so a failure reproduces from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6d2b79f5 >>> 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "<p>", "</p>", "<div>", "</div>", "<table>", "<tr>", "<td bgcolor=red>", "</td>", "</table>", "<ul>", "<ol>", "<li>", "</ul>",
  "<h1>", "</h1>", "<h5>", "<blockquote>", "</blockquote>", "<pre>", "</pre>", "<br>", "<hr>", "<b>", "</b>", "<i>", "<code>",
  '<a href="https://a.example/p?q=1">', '<a class="button" href="https://a.example/">', '<a href="http://a.example/">',
  '<a href="javascript:x">', '<a href="">', "</a>", '<img src="https://a.example/i.png" alt="x">', '<img src="cid:c">',
  '<img src="x" width=1>', '<span style="display:none">', '<span style="font-weight:700;text-align:right">', "</span>",
  "<script>", "</script>", "<style>", "<svg>", "<template>", "<!--", "-->", "<center>", "<figcaption>", "<form>", "<input>",
  "text ", "more text. ", "café ", "é ", "👋 ", "\ud800 ", "\u0000", "​", "&nbsp;", "&amp;", "&#x0;", "<", ">", "\n", "\t",
  "‮", "x".repeat(200),
];

describe("arbitrary markup", () => {
  it("always yields valid text blocks or a typed input error", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = generator(seed);
      let html = "";
      for (let count = 1 + Math.floor(random() * 120); count > 0; count--) html += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      const raw = new TextEncoder().encode(`From: a@b.example\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`);
      try {
        const converted = await convertEmail(raw);
        const blocks = converted.blocks.filter(block => block._type === "block");
        expect(() => validatePayload("hail.body.spt-2", { version: 1, profile: "spt-2", blocks }), `seed ${seed}`).not.toThrow();
      } catch (error) {
        expect(error, `seed ${seed}`).toBeInstanceOf(BridgeInputError);
      }
    }
  });
});

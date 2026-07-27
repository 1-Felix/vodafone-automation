import test from "node:test";
import assert from "node:assert/strict";
import { parseUssdBalance } from "./spitz.mjs";

const ucs2 = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");

test("parses German plain-text balance with comma decimal", () => {
  const r = parseUssdBalance('+CUSD: 0,"Ihr aktuelles Guthaben betraegt: 12,34 EUR.",15');
  assert.equal(r.eur, 12.34);
  assert.match(r.text, /Guthaben/);
});
test("parses dot-decimal and € symbol", () => {
  assert.equal(parseUssdBalance('+CUSD: 0,"Guthaben: 7.05 €",15').eur, 7.05);
});
test("decodes UCS2-hex payload", () => {
  const r = parseUssdBalance(`+CUSD: 0,"${ucs2("Ihr Guthaben: 9,99 EUR")}",72`);
  assert.equal(r.eur, 9.99);
  assert.match(r.text, /Ihr Guthaben/);
});
test("readable payload without amount keeps text, eur null", () => {
  const r = parseUssdBalance('+CUSD: 0,"Dieser Dienst ist derzeit nicht verfuegbar",15');
  assert.equal(r.eur, null);
  assert.match(r.text, /Dienst/);
});
test("returns null on no payload or garbage", () => {
  assert.equal(parseUssdBalance("+CUSD: 2"), null);
  assert.equal(parseUssdBalance("ERROR"), null);
  assert.equal(parseUssdBalance(""), null);
  assert.equal(parseUssdBalance('+CUSD: 0,"",15'), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseCountersTotal } from "./spitz.mjs";

test("parseCountersTotal sums rx and tx lines", () => {
  assert.equal(parseCountersTotal("12345\n678\n"), 13023);
});

test("parseCountersTotal returns null on garbage", () => {
  assert.equal(parseCountersTotal("cat: no such file\n"), null);
  assert.equal(parseCountersTotal("ERR\n"), null);
});

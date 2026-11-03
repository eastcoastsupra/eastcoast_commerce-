import test from "node:test";
import assert from "node:assert/strict";
import { buildTurn14IdentifierIndex, matchWixProduct } from "../src/sync/match.js";

function item(id, attributes) {
  return { id, attributes };
}

test("matches a Chemical Guys Wix SKU to an exact manufacturer part number", () => {
  const turn14Item = item("42", {
    brand: "Chemical Guys",
    part_number: "chg-CWS_402",
    mfr_part_number: "CWS_402"
  });
  const index = buildTurn14IdentifierIndex([turn14Item]);
  const result = matchWixProduct(
    { name: "Chemical Guys Mr. Pink", brand: "Chemical Guys", sku: "CWS-402" },
    "Chemical Guys",
    index
  );

  assert.equal(result.status, "matched");
  assert.equal(result.item.id, "42");
  assert.equal(result.matchedField, "mfr_part_number");
});

test("skips a product without a Wix SKU", () => {
  const result = matchWixProduct(
    { name: "Chemical Guys Product", brand: "Chemical Guys", sku: "" },
    "Chemical Guys",
    new Map()
  );
  assert.deepEqual(result, { status: "skipped", reason: "missing-wix-sku" });
});

test("rejects ambiguous exact identifiers", () => {
  const index = buildTurn14IdentifierIndex([
    item("1", { brand: "Chemical Guys", mfr_part_number: "ABC-1" }),
    item("2", { brand: "Chemical Guys", mfr_part_number: "ABC1" })
  ]);
  const result = matchWixProduct(
    { name: "Chemical Guys Product", brand: "Chemical Guys", sku: "ABC1" },
    "Chemical Guys",
    index
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "ambiguous-turn14-identifier");
});

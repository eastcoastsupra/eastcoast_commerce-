import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifiedProductWeight } from "../src/sync/importProducts.js";

const policy = JSON.parse(await readFile(new URL("../config/Shipping.json", import.meta.url), "utf8"));
const sites = [{ key: "eastcoastsupra" }, { key: "ecbmw" }];

test("merchant-confirmed supplier and store weights are pounds per box", () => {
  assert.equal(policy.verified, true);
  assert.equal(policy.sourceWeightUnit, "LB");
  assert.equal(policy.sourceWeightBasis, "PER_BOX");
  assert.equal(policy.sourceWeightField, "attributes.dimensions[].weight");
  assert.deepEqual(policy.sourceDisplayOrder, ["length", "width", "height", "weight"]);
  for (const site of sites) assert.equal(policy.siteWeightUnits[site.key], "LB");
});

test("length width height are never multiplied or substituted for actual pounds", () => {
  const item = { shippingDimensions: [{ boxNumber: 1, length: 24, width: 12, height: 8, weight: 10.25 }] };
  for (const site of sites) assert.equal(verifiedProductWeight(item, site, policy), 10.25);
});

test("all distinct boxes contribute weight once with no pound-to-kilogram conversion", () => {
  const item = { shippingDimensions: [
    { boxNumber: 1, length: 24, width: 12, height: 8, weight: 10.25 },
    { boxNumber: 2, length: 8, width: 6, height: 4, weight: 2.75 }
  ] };
  for (const site of sites) assert.equal(verifiedProductWeight(item, site, policy), 13);
});

test("confirmed units do not bypass missing invalid zero or duplicated box weights", () => {
  const invalid = [
    [],
    [{ boxNumber: 1, length: 24, width: 12, height: 8 }],
    [{ boxNumber: 1, weight: 0 }],
    [{ boxNumber: 1, weight: -1 }],
    [{ boxNumber: 1, weight: "10.25" }],
    [{ boxNumber: 1, weight: Number.NaN }],
    [{ boxNumber: 1, weight: Number.POSITIVE_INFINITY }],
    [{ boxNumber: 1, weight: 2 }, { boxNumber: 1, weight: 3 }]
  ];
  for (const shippingDimensions of invalid) {
    for (const site of sites) assert.equal(verifiedProductWeight({ shippingDimensions }, site, policy), null);
  }
});

test("unknown sites and revoked unit verification remain blocked", () => {
  const item = { shippingDimensions: [{ boxNumber: 1, weight: 10 }] };
  assert.equal(verifiedProductWeight(item, { key: "unknown" }, policy), null);
  assert.equal(verifiedProductWeight(item, sites[0], { ...policy, verified: false }), null);
});

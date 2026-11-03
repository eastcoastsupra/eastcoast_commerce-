import test from "node:test";
import assert from "node:assert/strict";
import { buildSupplierMatchIndex, resolveCatalogProduct, buildWixDuplicateIndex, checkCatalogDuplicate, extractLabelledIdentifiers } from "../src/sync/catalogMatch.js";

const item = { itemId: "100", brand: "Chemical Guys", sku: "CHEM-HS16", mpn: "HS-16", unitsPerSku: 1, description: "Chemical Guys HydroSpeed 16oz", purchaseCost: 5 };
const other = { itemId: "200", brand: "Other", sku: "OTHER-HS16", mpn: "HS-16", unitsPerSku: 1, description: "Other cleaner" };
const index = buildSupplierMatchIndex([item, other]);
const product = { id: "p1", name: item.description, sku: "HS-16", brand: "", visible: true };

test("full supplier SKU is globally scoped; manufacturer part numbers need exact brand", () => {
  assert.equal(resolveCatalogProduct(product, index).targets[0].supplierItemId, "100");
  assert.equal(resolveCatalogProduct({ ...product, name: "Cleaner", sku: item.sku }, index).targets[0].supplierItemId, "100");
  assert.equal(resolveCatalogProduct({ ...product, name: "Cleaner", sku: item.mpn }, index).status, "hold");
  assert.equal(resolveCatalogProduct({ ...product, brand: "Other", sku: item.sku }, index).reason, "brand-conflict");
  assert.equal(JSON.stringify([...index.byId.values()]).includes("purchaseCost"), false);
});

test("durable Turn 14 SKUs require exact spelling, verified brand, and a current single-unit item", () => {
  const managed = { ...product, sku: "T14-100" };
  assert.equal(resolveCatalogProduct(managed, index).targets[0].source, "managed-turn14-sku");
  assert.equal(resolveCatalogProduct({ ...managed, name: "Cleaner" }, index).reason, "managed-sku-requires-verified-brand");
  assert.equal(resolveCatalogProduct({ ...managed, sku: "T14100" }, index).reason, "noncanonical-managed-sku");
  assert.equal(resolveCatalogProduct(managed, buildSupplierMatchIndex([{ ...item, unitsPerSku: 12 }])).reason, "casepack-or-unknown-selling-unit");
  assert.equal(checkCatalogDuplicate(item, buildWixDuplicateIndex([managed], index)).status, "duplicate");
  assert.equal(checkCatalogDuplicate({ ...item, itemId: undefined }, buildWixDuplicateIndex([], index)).reason, "missing-new-product-identity");
});

test("brand inference requires an unambiguous complete prefix, not a substring", () => {
  assert.equal(resolveCatalogProduct({ ...product, name: "Our Chemical Guys cleaner" }, index).status, "hold");
  const ambiguous = buildSupplierMatchIndex([item, { ...other, brand: "Chemical", sku: "SECOND" }]);
  assert.equal(resolveCatalogProduct(product, ambiguous).reason, "ambiguous-brand-prefix");
});

test("collisions, casepacks, unknown units, and custom bundles are protected", () => {
  const collision = buildSupplierMatchIndex([item, { ...item, itemId: "300", sku: "CHEMHS16" }]);
  assert.equal(resolveCatalogProduct({ ...product, sku: item.sku }, collision).reason, "ambiguous-normalized-identifier");
  assert.equal(resolveCatalogProduct(product, buildSupplierMatchIndex([{ ...item, unitsPerSku: 12 }])).reason, "casepack-or-unknown-selling-unit");
  assert.equal(resolveCatalogProduct({ ...product, name: `${item.description} bundle` }, index).reason, "custom-bundle-mismatch");
});

test("missing SKU recovers only from an explicit labelled MPN and brand", () => {
  const empty = { ...product, sku: "", description: "<p>Manufacturer Part Number: <strong>HS-16</strong></p>" };
  const result = resolveCatalogProduct(empty, index);
  assert.equal(result.targets[0].source, "labelled-manufacturer-part-number");
  assert.equal(result.targets[0].needsSku, true);
  assert.equal(resolveCatalogProduct({ ...empty, description: "HydroSpeed HS-16 fits your car" }, index).status, "hold");
  assert.equal(resolveCatalogProduct({ ...empty, description: "<p>SKU: CHEM-HS16</p>" }, index).status, "hold");
  assert.equal(resolveCatalogProduct({ ...empty, description: "<p>OEM References</p><p>MPN: HS-16</p>" }, index).status, "hold");
  assert.deepEqual(extractLabelledIdentifiers("<script>MPN: BAD</script><p>Installation</p><p>MPN: HS-16</p>"), []);
});

test("conflicting labelled identities never recover a missing SKU", () => {
  const second = { ...item, itemId: "300", sku: "CHEM-HS32", mpn: "HS-32" };
  assert.equal(resolveCatalogProduct({ ...product, sku: "", description: "MPN: HS-16\nMPN: HS-32" }, buildSupplierMatchIndex([item, second])).reason, "conflicting-labelled-identities");
});

test("managed variants use exact variant SKUs and IDs without parent substitution", () => {
  const managed = { ...product, manageVariants: true, variants: [{ id: "v1", choices: { Size: "16oz" }, variant: { sku: item.sku } }, { id: "v2", choices: { Size: "32oz" }, variant: { sku: "" } }] };
  const result = resolveCatalogProduct(managed, index);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].variantId, "v1");
  assert.equal(result.holds[0].reason, "missing-variant-sku");
  assert.equal(resolveCatalogProduct({ ...managed, variants: [] }, index).reason, "managed-variants-not-loaded");
  const simple = { ...product, manageVariants: false, productOptions: [], variants: [{ id: "00000000-0000-0000-0000-000000000000", choices: {}, variant: { sku: "" } }] };
  assert.equal(resolveCatalogProduct(simple, index).targets[0].variantId, null);
  assert.equal(resolveCatalogProduct({ ...managed, variants: [managed.variants[0], managed.variants[0]] }, index).targets.length, 0);
  assert.equal(resolveCatalogProduct({ ...managed, variants: [managed.variants[0], { ...managed.variants[0], id: "v3" }] }, index).reason, "duplicate-supplier-variant-mapping");
});

test("hidden products and all variant SKUs block duplicate creation", () => {
  const hidden = { ...product, sku: "", visible: false, manageVariants: true, variants: [{ id: "v1", variant: { sku: item.sku } }] };
  const duplicates = buildWixDuplicateIndex([hidden], index);
  assert.equal(checkCatalogDuplicate(item, duplicates).status, "duplicate");
  assert.equal(checkCatalogDuplicate(item, duplicates).references[0].hidden, true);
  assert.equal(checkCatalogDuplicate(item, buildWixDuplicateIndex([{ ...product, visible: false }], index)).reason, "existing-brand-mpn");
});

test("exact normalized names only hold creates and cannot authorize updates", () => {
  const missing = { ...product, sku: "", name: "Chemical Guys HydroSpeed 16oz" };
  assert.equal(checkCatalogDuplicate(item, buildWixDuplicateIndex([missing], index)).status, "hold");
  assert.equal(resolveCatalogProduct(missing, index).status, "hold");
  assert.equal(checkCatalogDuplicate(item, buildWixDuplicateIndex([{ ...missing, name: "Chemical Guys HydroSpeed 1gal" }], index)).status, "clear");
});

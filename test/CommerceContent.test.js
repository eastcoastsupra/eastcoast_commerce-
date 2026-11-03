import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, plainText, productSeo, supplierProductName } from "../src/sync/content.js";

test("SEO identifies the actual product/store without new fitment or price claims", () => {
  const result = productSeo({ name: "Chemical Guys HydroSpeed 16oz (P6)" }, { name: "East Coast Supra" });
  assert.match(result.title, /HydroSpeed 16oz \(P6\)/u);
  assert.match(result.title, /East Coast Supra/u);
  assert.ok(result.description.length <= 160);
  assert.doesNotMatch(result.description, /in stock|free shipping|sale|fits Toyota/iu);
});

test("supplier content is inert and long catalog names retain complete identifiers", () => {
  assert.equal(plainText("<script>bad()</script><b>A &amp; B</b>"), "A & B");
  assert.equal(escapeHtml('<img src="x" onerror="bad()">'), "&lt;img src=&quot;x&quot; onerror=&quot;bad()&quot;&gt;");
  const name = supplierProductName("Verified manufacturer product description with a long list of precise specifications and applications", "ABC-123-RED");
  assert.ok(name.length <= 80);
  assert.ok(name.endsWith("ABC-123-RED"));
});

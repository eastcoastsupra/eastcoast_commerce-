import test from "node:test";
import assert from "node:assert/strict";
import { planSeoChange, verifySeoReadback } from "../scripts/RefreshSeo.mjs";
import { productSeo } from "../src/sync/content.js";
import { SITES } from "../src/config/sites.js";

const supra = SITES.eastcoastsupra;
const bmw = SITES.ecbmw;
// Synthetic merchandise fixture; do not copy live merchant catalog records.
const merchandise = { id: "cross-brand-merchandise", name: "East Coast BMW Example Mug" };

function seoTags(product, site) {
  const generated = productSeo(product, site);
  return { tags: [
    { type: "title", children: generated.title },
    { type: "meta", props: { name: "description", content: generated.description } }
  ] };
}

test("SEO refresh preserves correct generated cross-brand merchandise tags and is idempotent", () => {
  const product = { ...merchandise, seoData: seoTags(merchandise, supra) };
  const original = structuredClone(product);
  assert.equal(product.seoData.tags[0].children,
    "East Coast BMW Example Mug | East Coast Supra");
  assert.equal(product.seoData.tags[1].props.content,
    "Shop East Coast BMW Example Mug at East Coast Supra. View product details and specifications.");

  const plan = planSeoChange(product, supra);
  assert.equal(plan.changed, false);
  assert.equal(plan.correctIdentity, false);
  assert.equal(plan.fillTitle, false);
  assert.equal(plan.fillDescription, false);
  assert.deepEqual(plan.seoData, original.seoData);
  assert.deepEqual(product, original);

  const filled = planSeoChange(merchandise, supra);
  assert.equal(filled.changed, true);
  assert.deepEqual(filled.seoData, original.seoData);
  const repeated = planSeoChange({ ...merchandise, seoData: filled.seoData }, supra);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.seoData, original.seoData);
});

test("SEO refresh still corrects an incorrect store suffix and generated description", () => {
  const product = { id: "radiator", name: "Performance Radiator" };
  product.seoData = seoTags(product, bmw);
  const plan = planSeoChange(product, supra);

  assert.equal(plan.changed, true);
  assert.equal(plan.correctIdentity, true);
  assert.equal(plan.fillTitle, false);
  assert.equal(plan.fillDescription, false);
  assert.deepEqual(plan.seoData, seoTags(product, supra));
  assert.equal(planSeoChange({ ...product, seoData: plan.seoData }, supra).changed, false);
});

test("SEO identity correction preserves custom metadata, other tag types, and disabled tags", () => {
  const product = { id: "radiator", name: "Performance Radiator", seoData: {
    settings: { preventAutoRedirect: true, keywords: ["merchant keyword"] },
    tags: [
      { type: "title", children: "Performance Radiator | East Coast BMW", custom: false,
        props: { "data-source": "merchant" }, disabled: false },
      { type: "meta", props: { name: "description", content: "Merchant copy at East Coast BMW." },
        disabled: true, custom: true },
      { type: "link", props: { rel: "canonical", href: "https://ecbmw.com/merchant-url" } },
      { type: "meta", props: { property: "og:title", content: "East Coast BMW social title" } },
      { type: "script", props: { type: "application/ld+json" }, children: '{"name":"East Coast BMW"}' }
    ]
  } };
  const original = structuredClone(product);
  const plan = planSeoChange(product, supra);
  assert.equal(plan.changed, true);
  assert.equal(plan.correctIdentity, true);
  assert.equal(plan.fillDescription, false);
  assert.deepEqual(plan.seoData.settings, original.seoData.settings);
  assert.deepEqual(plan.seoData.tags[0], {
    ...original.seoData.tags[0], children: "Performance Radiator | East Coast Supra"
  });
  assert.deepEqual(plan.seoData.tags.slice(1), original.seoData.tags.slice(1));
  assert.deepEqual(product, original);

  const disabledTitle = {
    ...merchandise, seoData: { tags: [
      { type: "title", children: "", disabled: true, custom: true },
      seoTags(merchandise, supra).tags[1]
    ] }
  };
  const disabledPlan = planSeoChange(disabledTitle, supra);
  assert.equal(disabledPlan.changed, false);
  assert.equal(disabledPlan.fillTitle, false);
  assert.deepEqual(disabledPlan.seoData, disabledTitle.seoData);
});

test("SEO readback accepts the exact intended cross-brand signature and rejects changed product wording", async () => {
  const expected = seoTags(merchandise, supra);
  let reads = 0;
  const waits = [];
  const readback = structuredClone(expected);
  readback.tags.reverse();
  readback.tags.push({ type: "meta", props: { property: "og:title", content: "East Coast BMW" } });

  await verifySeoReadback({ async getProduct(id) {
    reads += 1;
    return { product: { id, seoData: readback } };
  } }, merchandise.id, expected, supra, { wait: async (delay) => waits.push(delay) });
  assert.equal(reads, 1);
  assert.deepEqual(waits, []);

  const corrupted = structuredClone(expected);
  corrupted.tags[0].children = corrupted.tags[0].children.replace("East Coast BMW", "East Coast Supra");
  await assert.rejects(verifySeoReadback({ async getProduct(id) {
    return { product: { id, seoData: corrupted } };
  } }, merchandise.id, expected, supra, { delays: [] }), /did not match the intended tags/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { findBrand } from "../src/turn14/catalog.js";

test("findBrand resolves exact normalized brand name", async () => {
  const client = {
    async get(path) {
      assert.equal(path, "/v1/brands");
      return {
        data: [
          { id: "1", attributes: { name: "Other" } },
          { id: "2", attributes: { name: "Chemical Guys" } }
        ]
      };
    }
  };

  const brand = await findBrand(client, "chemical-guys");
  assert.equal(brand.id, "2");
});

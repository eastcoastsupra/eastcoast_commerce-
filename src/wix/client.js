import { requestJson } from "../lib/http.js";

const QUERY_PRODUCTS_URL = "https://www.wixapis.com/stores-reader/v1/products/query";
const UPDATE_PRODUCT_URL = "https://www.wixapis.com/stores/v1/products";

export class WixCatalogV1Client {
  constructor({ apiKey, siteId, httpRuntime }) {
    this.apiKey = apiKey;
    this.siteId = siteId;
    this.httpRuntime = httpRuntime;
  }

  headers() {
    return {
      authorization: this.apiKey,
      "wix-site-id": this.siteId,
      "content-type": "application/json",
      accept: "application/json"
    };
  }

  async queryProductsPage(offset, limit = 100) {
    return requestJson(
      QUERY_PRODUCTS_URL,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          query: {
            paging: {
              limit,
              offset
            }
          }
        })
      },
      this.httpRuntime
    );
  }

  async listAllProducts() {
    const limit = 100;
    const products = [];
    let offset = 0;

    while (true) {
      const response = await this.queryProductsPage(offset, limit);
      const page = Array.isArray(response?.products) ? response.products : [];
      products.push(...page);

      const totalResults = Number(response?.totalResults ?? products.length);
      if (products.length >= totalResults || page.length === 0) {
        return products;
      }

      offset += page.length;
    }
  }

  async updatePrice(productId, price) {
    return requestJson(
      `${UPDATE_PRODUCT_URL}/${encodeURIComponent(productId)}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          product: {
            id: productId,
            priceData: {
              price
            }
          }
        })
      },
      this.httpRuntime
    );
  }
}

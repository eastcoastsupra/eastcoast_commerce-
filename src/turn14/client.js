import { requestJson } from "../lib/http.js";

export class Turn14Client {
  constructor({ clientId, clientSecret, baseUrl, httpRuntime }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.httpRuntime = httpRuntime;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const response = await requestJson(
      `${this.baseUrl}/v1/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.clientId,
          client_secret: this.clientSecret
        })
      },
      this.httpRuntime
    );

    if (!response?.access_token || !Number.isFinite(Number(response.expires_in))) {
      throw new Error("Turn 14 token response is missing access_token or expires_in.");
    }

    this.accessToken = response.access_token;
    this.tokenExpiresAt = now + Number(response.expires_in) * 1000;
    return this.accessToken;
  }

  async get(path) {
    const token = await this.getAccessToken();
    return requestJson(
      `${this.baseUrl}${path}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json"
        }
      },
      this.httpRuntime
    );
  }
}

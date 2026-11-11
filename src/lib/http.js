function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function readResponseBody(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  return text ? { message: text } : null;
}

export class HttpError extends Error {
  constructor(message, { status, url, body }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export async function requestJson(url, options = {}, runtime = {}) {
  const timeoutMs = runtime.timeoutMs ?? 30000;
  const retries = runtime.retries ?? 3;
  const retryBaseMs = runtime.retryBaseMs ?? 750;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let controller, timeout;

    try {
      const start = () => {
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        return (runtime.fetcher ?? globalThis.fetch)(url, { ...options, signal: controller.signal });
      };
      // A supplier lane can delay admission without consuming the request timeout.
      const response = await (runtime.startAttempt ? runtime.startAttempt(start) : start());
      const body = await readResponseBody(response);

      if (response.ok) {
        return body;
      }

      if (attempt < retries && shouldRetry(response.status)) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : retryBaseMs * 2 ** attempt;
        await sleep(delay);
        continue;
      }

      throw new HttpError(`HTTP ${response.status} for ${url}`, {
        status: response.status,
        url,
        body
      });
    } catch (error) {
      const isAbort = error && typeof error === "object" && error.name === "AbortError";
      if (attempt < retries && (isAbort || error instanceof TypeError)) {
        await sleep(retryBaseMs * 2 ** attempt);
        continue;
      }
      if (isAbort) {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Request failed after ${retries + 1} attempts: ${url}`);
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_ATTEMPTS = 3;

export interface PreparedHttpRequest {
  url: string;
  init: RequestInit;
}

export interface ExecutedHttpResponse {
  response: Response;
  attempts: number;
}

export interface HttpExecutorOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retryAfterHeader?: string;
  rebuildOnUnauthorized?: () => Promise<PreparedHttpRequest | null>;
}

export async function executeHttpRequest(
  request: PreparedHttpRequest,
  options: HttpExecutorOptions = {},
): Promise<ExecutedHttpResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attempts = 0;
  let currentRequest = request;
  let unauthorizedRetried = false;

  while (true) {
    attempts += 1;
    const response = await fetchImpl(currentRequest.url, {
      ...currentRequest.init,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 401 && !unauthorizedRetried && options.rebuildOnUnauthorized) {
      unauthorizedRetried = true;
      const rebuiltRequest = await options.rebuildOnUnauthorized();
      if (rebuiltRequest) {
        currentRequest = rebuiltRequest;
        continue;
      }
    }

    if ((response.status === 429 || response.status === 503) && attempts < MAX_ATTEMPTS) {
      const delayMs = getRetryDelayMs(response, attempts, options.retryAfterHeader);
      await sleep(delayMs);
      continue;
    }

    return {
      response,
      attempts,
    };
  }
}

export async function parseHttpResponseBody(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (rawText.trim() === "") {
    return null;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      return rawText;
    }
  }

  return rawText;
}

export function headersToObject(headers: Headers): Record<string, string> {
  const renderedHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    renderedHeaders[key] = value;
  });
  return renderedHeaders;
}

function getRetryDelayMs(response: Response, attempts: number, retryAfterHeader?: string): number {
  if (response.status === 429) {
    const headerName = retryAfterHeader ?? "Retry-After";
    const headerValue = response.headers.get(headerName) ?? response.headers.get("Retry-After");
    const parsedDelay = parseRetryAfterHeader(headerValue);
    if (parsedDelay !== null) {
      return parsedDelay;
    }
  }

  return DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1);
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 10_000) {
      return Math.max(0, Math.round(numeric * 1000 - Date.now()));
    }

    return Math.max(0, Math.round(numeric * 1000));
  }

  const parsedDate = Date.parse(value);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

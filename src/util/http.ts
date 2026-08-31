export type RequestErrorKind = "timeout" | "network" | "http";

export class RequestError extends Error {
  readonly kind: RequestErrorKind;
  readonly status?: number;

  constructor(message: string, kind: RequestErrorKind, status?: number) {
    super(message);
    this.name = "RequestError";
    this.kind = kind;
    this.status = status;
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 30_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 30_000)) : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchRetryOptions {
  timeoutMs?: number;
  retries?: number;
  retryPost?: boolean;
  label?: string;
}

/** Fetch with a hard timeout, bounded exponential backoff, and error classification. */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 2;
  const method = (init.method ?? "GET").toUpperCase();
  const canRetryPost = options.retryPost ?? false;
  const attempts = method === "GET" || method === "HEAD" || canRetryPost ? retries + 1 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (response.ok || !retryableStatus(response.status) || attempt === attempts - 1) return response;
      await response.body?.cancel().catch(() => {});
      await wait(retryAfterMs(response) ?? Math.min(250 * 2 ** attempt, 4_000));
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === "AbortError";
      lastError = new RequestError(
        `${options.label ?? "请求"}${isAbort ? "超时" : "网络错误"}`,
        isAbort ? "timeout" : "network",
      );
      if (attempt === attempts - 1) throw lastError;
      await wait(Math.min(250 * 2 ** attempt, 4_000));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new RequestError(`${options.label ?? "请求"}失败`, "network");
}

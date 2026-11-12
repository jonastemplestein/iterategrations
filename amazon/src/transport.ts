export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ZincObject = { [key: string]: Json };
export type Fetch = (request: Request) => Promise<Response>;

export function objectOf(value: unknown): ZincObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("amazon: Zinc returned an invalid response");
  return value as ZincObject;
}

/** Provider messages can echo request material. Return only a bounded machine code. */
export class ZincError extends Error {
  readonly status: number;
  readonly code: string;
  readonly outcomeUnknown: boolean;

  constructor(status: number, code: string, outcomeUnknown = false) {
    super(
      `amazon: Zinc ${code} (HTTP ${status})` +
        (outcomeUnknown
          ? "; order outcome unknown: check Zinc and retain the same idempotency key"
          : ""),
    );
    this.name = "ZincError";
    this.status = status;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

/** Fixed origin, no redirects and no retries. Password setup also uses this transport. */
export async function zincRequest(
  fetch: Fetch,
  authorization: string,
  path: string,
  body?: ZincObject,
): Promise<ZincObject> {
  const url = new URL(path, "https://api.zinc.com");
  if (
    !path.startsWith("/") ||
    url.origin !== "https://api.zinc.com" ||
    url.username ||
    url.password
  )
    throw new Error("amazon: Zinc requests must stay on api.zinc.com");
  const placing = path === "/orders" && body !== undefined;
  let response: Response;
  try {
    response = await fetch(
      new Request(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: { authorization, accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } catch {
    throw new ZincError(0, "transport_error", placing);
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value && typeof value === "object" ? (value as ZincObject) : {};
    const detail = error.error && typeof error.error === "object" ? error.error : error;
    const code = !Array.isArray(detail) && "code" in detail ? detail.code : undefined;
    throw new ZincError(
      response.status,
      typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "request_failed",
      placing && response.status >= 500,
    );
  }
  try {
    return objectOf(value);
  } catch {
    throw new ZincError(response.status, "invalid_response", placing);
  }
}

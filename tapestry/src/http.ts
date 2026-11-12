export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Errors omit server messages, which can contain account data or request credentials. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | number | undefined;

  constructor(service: string, status: number, code?: string | number) {
    super(`${service}: request failed (HTTP ${status}${code === undefined ? "" : `, ${code}`})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function jsonResponse(response: Response, service: string): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = object(body) && typeof body.type === "string" ? body.type : undefined;
    throw new ApiError(service, response.status, code);
  }
  if (body === undefined) throw new ApiError(service, response.status, "invalid-json");
  return body;
}

export function required(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

export function pageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new Error("Page size must be an integer from 1 to 100");
  return value;
}

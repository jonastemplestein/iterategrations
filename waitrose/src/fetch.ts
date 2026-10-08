/** What every Waitrose request carries. The token is a placeholder: egress swaps in the real one on
 *  its way to https://www.waitrose.com, the secret's only origin, and logs in again by the secret's
 *  refresh (`exchange.ts`) when Waitrose answers 401. Waitrose's edge answers a request with no user
 *  agent with HTTP 520. */
const HEADERS = {
  authorization: 'Bearer getSecret("/secrets/waitrose", { field: "accessToken" })',
  "user-agent": "Waitrose/3.9.1 (Android)",
  accept: "application/json",
};

const GRAPHQL_URL = "https://www.waitrose.com/api/graphql-prod/graph/live";

/** `fetch` with the headers every Waitrose call needs merged in, and `content-type:
 *  application/json` when there is a body. Headers in `init` win. In every worker the platform
 *  loads, the global `fetch` is the project's egress. */
export function waitroseFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(
    init.body ? { ...HEADERS, "content-type": "application/json" } : HEADERS,
  );
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return fetch(input, { ...init, headers });
}

/** One GraphQL operation (`OPERATIONS`), posted as `{ query, variables }`: its `data`. Throws on an
 *  HTTP error, and on a non-empty `errors` list with their messages. A refusal that Waitrose answers
 *  as `failures` inside `data` comes back as data: the caller checks it. */
export async function graphql<T = any>(
  operation: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await waitroseFetch(GRAPHQL_URL, {
    method: "POST",
    body: JSON.stringify({ query: operation, variables }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const answer = (await response.json()) as { data: T; errors?: { message: string }[] };
  if (answer.errors?.length)
    throw new Error(`GraphQL Error: ${answer.errors.map((error) => error.message).join(", ")}`);
  return answer.data;
}

/** What every request to a school's Arbor site carries, as the Android parent app sends it. The
 *  token is a placeholder: egress swaps in the real one on its way to the secret's pinned origins,
 *  and logs in again by the secret's refresh (`exchange.ts`) when Arbor answers 401.
 *  `arbor-client: Mobile` selects the app's page format (a tree of named components); without it
 *  Arbor answers the web front end's format instead. */
const HEADERS = {
  authorization: 'Bearer getSecret("/secrets/arbor", { field: "accessToken" })',
  "arbor-client": "Mobile",
  "mobile-app-version": "0.22.0",
  "x-pci-compliant": "yes",
  accept: "application/json",
  "user-agent": "okhttp/4.12.0",
};

/** `fetch` with the headers every Arbor call needs merged in, and `content-type:
 *  application/json` when there is a body. Headers in `init` win. In every worker the platform
 *  loads, the global `fetch` is the project's egress. */
export function arborFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(
    init.body ? { ...HEADERS, "content-type": "application/json" } : HEADERS,
  );
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return fetch(input, { ...init, headers });
}

/** A path on the school's site, as Arbor's pages give it (`/guardians/…`, `guardians/…`, or the
 *  web front end's `/?/guardians/…`), made a URL on `site`. A full URL stays as it is. */
export function arborUrl(site: string, path: string): URL {
  if (/^https?:\/\//i.test(path)) return new URL(path);
  return new URL(path.replace(/^\/*(\?\/)?\/*/, ""), site.trim().replace(/\/*$/, "/"));
}

/** Arbor's error text: its `message` (often HTML), as plain text, short. */
const reasonOf = (text: string): string => {
  let message = text;
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body?.message === "string") message = body.message;
  } catch {
    // not JSON: the text is the message
  }
  return message
    .replace(/<[^>]*>/g, " ")
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
};

/** One GET of a page or a data endpoint on `site`: its JSON. A page is a tree of components
 *  (`UiNode`); a data endpoint is `{ items, success, action_params }`. Throws on an HTTP error
 *  (`HTTP <status>: <Arbor's message>`) and on an answer with `success: false`. */
export async function arborGet<T = any>(site: string, path: string): Promise<T> {
  const response = await arborFetch(arborUrl(site, path));
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${reasonOf(text)}`);
  let answer: T;
  try {
    answer = JSON.parse(text) as T;
  } catch {
    throw new Error(`Arbor answered no JSON: ${reasonOf(text).slice(0, 80)}`);
  }
  if ((answer as { success?: unknown } | null)?.success === false)
    throw new Error(`Arbor refused: ${reasonOf(text)}`);
  return answer;
}

/** What Arbor answers a form action. `validation_errors` is by field (`__form__` for the whole
 *  form); `loadPage` and `downloadUrl` are where the app goes next. */
export type FormAnswer = {
  success: boolean;
  action_params?: {
    validation_errors?: Record<string, string[]>;
    loadPage?: string;
    downloadUrl?: string;
    [name: string]: unknown;
  };
  notifications?: unknown[];
  [name: string]: unknown;
};

/** SUBMITS ONE OF ARBOR'S FORMS: this writes. It is how the app chooses meals, sends a message to
 *  the school, and does every other change. `action` is a `form-action`'s `url`, and `fields` maps
 *  each `targetField` to its value, as `readForm` gives them. It posts, once,
 *  `{ fields: { <targetField>: { value } } }` to the action with `format=json`, as the app does.
 *  Never retried. Throws on an HTTP error; a refusal is `success: false` with
 *  `action_params.validation_errors`: check it. */
export async function submitForm(
  site: string,
  action: string,
  fields: Record<string, unknown>,
): Promise<FormAnswer> {
  const url = arborUrl(site, action);
  url.searchParams.set("format", "json");
  const response = await arborFetch(url, {
    method: "POST",
    body: JSON.stringify({
      fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { value }])),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${reasonOf(text)}`);
  try {
    return JSON.parse(text) as FormAnswer;
  } catch {
    throw new Error(`Arbor answered no JSON: ${reasonOf(text).slice(0, 80)}`);
  }
}

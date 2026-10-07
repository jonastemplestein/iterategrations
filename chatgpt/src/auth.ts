/** The project, as this package uses it: what a config worker's `itx` already has. */
export type ChatgptItx = {
  fetch(request: Request): Promise<Response>;
  /** The project's own kv: only the root has it (a sub-context's `kv` is denied by default). */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  secrets: {
    set(
      path: string,
      material: string | Record<string, string>,
      options: { urls: string[]; refresh?: { kind: "worker"; source: string } },
    ): Promise<unknown>;
    delete(path: string): Promise<unknown>;
    list(): Promise<{ path: string }[]>;
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** OpenAI's Sign in with ChatGPT for open-source tools
 *  (https://developers.openai.com/siwc/token-sharing-open-source). A person lets an app spend their
 *  ChatGPT plan on Responses API requests. There is nothing to register: the app signs in as
 *  `dynamic_agent_client`, and OpenAI registers a public client of its own for that person during the
 *  consent and names it in the callback (`client_id`, an `oaiapp_…`). Refreshes use that one. */
export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL: string = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_URL: string = `${ISSUER}/api/accounts/oauth/token`;
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** The only redirect a public client gets: a loopback address. Nothing listens there. The browser
 *  fails to load it, and the person pastes its address into the page. */
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
/** Requests for this resource are what the plan pays for. The code exchange is refused without it
 *  (`invalid_grant`), and the code is spent. */
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
/** The secret that holds the tokens: `accessToken`, `refreshToken` and `clientId`. */
export const SECRET = "/secrets/chatgpt";
/** The only origins the tokens are ever sent to. */
export const PIN: string[] = ["https://api.openai.com", "https://auth.openai.com"];

/** The kv keys: the sign-in in progress, who is signed in (nothing secret), this project's host id. */
export const PENDING_KEY = "chatgpt/pending";
export const ACCOUNT_KEY = "chatgpt/account";
export const HOST_KEY = "chatgpt/host";

/** A sign-in the person has not finished. The verifier stays here, in the project. */
export type Pending = { url: string; state: string; verifier: string; expiresAt: number };
export type Account = { id: string; email?: string; plan?: string; at: string };

/** The claims of a JWT, or undefined for anything that is not one. Never verified: the token came
 *  straight from OpenAI's token endpoint over TLS, and the claims only label the account. */
export function claimsOf(token: string | undefined): Record<string, any> | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) =>
      c.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** The account an id token names: its OpenID `sub` (it differs for each sign-in), its address, and
 *  the plan when the token says. */
export function accountOf(idToken: string | undefined): Account {
  const claims = claimsOf(idToken) ?? {};
  if (typeof claims.sub !== "string" || claims.sub === "")
    throw new Error("OpenAI's answer names no account");
  const plan: unknown = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
  return {
    id: claims.sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof plan === "string" ? { plan } : {}),
    at: new Date().toISOString(),
  };
}

/** The exchange code the secret refreshes itself with (the platform runs it in a jail whose only
 *  egress is the secret's pin): on a 401 from OpenAI, trade the refresh token for new tokens with the
 *  client OpenAI registered. OpenAI rotates the refresh token, so the answer's is kept; the platform
 *  keeps what this returns. */
export const EXCHANGE_SOURCE: string = `const TOKEN_URL = ${JSON.stringify(TOKEN_URL)};
const RESOURCE = ${JSON.stringify(RESOURCE)};
export async function exchange(material, fetch) {
  if (!material.refreshToken || !material.clientId)
    throw new Error("the secret holds no refresh token or client id");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: material.clientId,
      refresh_token: material.refreshToken,
      resource: RESOURCE,
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = (body.error && body.error.code) || body.code || body.error || "";
    throw new Error(
      "ChatGPT refused the refresh (" + response.status + (typeof code === "string" && code ? " " + code : "") +
        "): connect ChatGPT again",
    );
  }
  const tokens = await response.json();
  if (!tokens.access_token) throw new Error("ChatGPT's refresh answered with no access token");
  return {
    ...material,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || material.refreshToken,
  };
}
`;

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const randomValue = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** OpenAI attributes the plan's usage to an "agent host", named by an opaque id of ours that stays
 *  the same: a random UUID, made once and kept. */
async function hostIdOf(itx: Pick<ChatgptItx, "kv">): Promise<string> {
  let id = await itx.kv.get(HOST_KEY);
  if (!id) {
    id = crypto.randomUUID();
    await itx.kv.put(HOST_KEY, id);
  }
  return `urn:uuid:${id}`;
}

/** Begin a sign-in: the consent URL the person opens. Nothing is sent to OpenAI yet. */
export async function startLogin(itx: Pick<ChatgptItx, "kv">): Promise<Pending> {
  const verifier = randomValue();
  const state = randomValue();
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    // what the consent page calls the app; the person may rename it there
    agent_name_hint: "iterate",
    ext_agent_host_id: await hostIdOf(itx),
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce: randomValue(),
  }).toString();
  const pending: Pending = {
    url: url.toString(),
    state,
    verifier,
    expiresAt: Date.now() + 15 * 60_000,
  };
  await itx.kv.put(PENDING_KEY, JSON.stringify(pending));
  return pending;
}

export async function readPending(itx: Pick<ChatgptItx, "kv">): Promise<Pending | null> {
  const value = await itx.kv.get(PENDING_KEY);
  if (!value) return null;
  const pending = JSON.parse(value) as Pending;
  return pending.expiresAt > Date.now() ? pending : null;
}

export async function readAccount(itx: Pick<ChatgptItx, "kv">): Promise<Account | null> {
  const value = await itx.kv.get(ACCOUNT_KEY);
  return value ? (JSON.parse(value) as Account) : null;
}

/** What the person pasted: the address the browser could not load. */
function callbackOf(pasted: string, pending: Pending): { code: string; clientId: string } {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error("Paste the whole address from the browser's address bar.");
  }
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname)
    throw new Error(`The address must start with ${REDIRECT_URI}`);
  const error = url.searchParams.get("error");
  if (error)
    throw new Error(
      `ChatGPT did not connect: ${url.searchParams.get("error_description") ?? error}`,
    );
  if (url.searchParams.get("state") !== pending.state)
    throw new Error("That address belongs to another sign-in. Start again.");
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!code) throw new Error("The address holds no authorization code. Start again.");
  if (!clientId) throw new Error("OpenAI's address names no client. Start again.");
  return { code, clientId };
}

/** Finish a sign-in: the pasted address holds the code and the client OpenAI registered. The code
 *  becomes tokens, which are kept as the secret (pinned to the API and OpenAI's sign-in, refreshed by
 *  `EXCHANGE_SOURCE`), and the person's account in the kv. */
export async function finishLogin(itx: ChatgptItx, pasted: string): Promise<Account> {
  const pending = await readPending(itx);
  if (!pending) throw new Error("No sign-in is open. Start again.");
  const { code, clientId } = callbackOf(pasted, pending);
  // the code is good once, so the sign-in ends here, whatever OpenAI answers
  await itx.kv.delete(PENDING_KEY);
  const answer = await itx.fetch(
    new Request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      }).toString(),
    }),
  );
  if (!answer.ok)
    throw new Error(
      `OpenAI would not hand over tokens (HTTP ${answer.status}: ${(await answer.text()).slice(0, 200)}). Start again.`,
    );
  const tokens = (await answer.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  };
  if (!tokens.access_token || !tokens.refresh_token)
    throw new Error("OpenAI's answer holds no access or refresh token. Start again.");
  if (!tokens.scope?.split(/\s+/).includes(DIRECT_SCOPE))
    throw new Error(
      "OpenAI did not grant the plan's usage to this sign-in. Is this a Plus or Pro personal account?",
    );
  const account = accountOf(tokens.id_token);
  await itx.secrets.set(
    SECRET,
    { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId },
    { urls: PIN, refresh: { kind: "worker", source: EXCHANGE_SOURCE } },
  );
  await itx.kv.put(ACCOUNT_KEY, JSON.stringify(account));
  return account;
}

export async function disconnect(itx: ChatgptItx): Promise<void> {
  await itx.secrets.delete(SECRET).catch(() => undefined);
  await itx.kv.delete(ACCOUNT_KEY);
  await itx.kv.delete(PENDING_KEY);
}

export async function isConnected(itx: Pick<ChatgptItx, "secrets">): Promise<boolean> {
  return (await itx.secrets.list()).some((secret) => secret.path === SECRET);
}

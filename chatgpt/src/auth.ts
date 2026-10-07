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
};

/** What a project's code is handed to run: `(call) => { using itx = this.getItx(); return call(itx); }` */
export type WithItx = <T>(call: (itx: ChatgptItx) => T) => Promise<Awaited<T>>;

/** ChatGPT's sign-in, and the client id every Codex sign-in uses (Codex CLI, opencode). */
export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Where a ChatGPT subscription's model requests go: the Responses API, as Codex calls it. */
export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
/** The secret that holds the tokens: `accessToken`, `refreshToken` and `accountId`. */
export const SECRET = "/secrets/chatgpt";
/** The only origins the tokens are ever sent to. */
export const PIN: string[] = ["https://chatgpt.com", "https://auth.openai.com"];

/** The kv keys: the sign-in in progress, and who is signed in (nothing secret). */
export const PENDING_KEY = "chatgpt/pending";
export const ACCOUNT_KEY = "chatgpt/account";

/** A sign-in the person has not finished: Codex's device code, good for 15 minutes. */
export type Pending = {
  deviceAuthId: string;
  userCode: string;
  /** Seconds between polls. */
  interval: number;
  expiresAt: number;
};
export type Account = { accountId: string; email?: string; plan?: string; at: string };
export type Tokens = { idToken: string; accessToken: string; refreshToken: string };

/** The URL the person opens, and types the code at. */
export const VERIFICATION_URL: string = `${ISSUER}/codex/device`;

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

/** The ChatGPT account an id token names. The account id is what `chatgpt-account-id` carries; a
 *  workspace (Business, Enterprise) has its own. */
export function accountOf(tokens: Pick<Tokens, "idToken" | "accessToken">): Account {
  const claims = claimsOf(tokens.idToken) ?? {};
  const access = claimsOf(tokens.accessToken) ?? {};
  const auth = claims["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {};
  const accountId: unknown = auth.chatgpt_account_id ?? claims.organizations?.[0]?.id;
  if (typeof accountId !== "string" || accountId === "")
    throw new Error("OpenAI's answer names no ChatGPT account. Is this a ChatGPT login?");
  const email: unknown =
    claims.email ?? claims["https://api.openai.com/profile"]?.email ?? access.email;
  const plan: unknown = auth.chatgpt_plan_type;
  return {
    accountId,
    ...(typeof email === "string" ? { email } : {}),
    ...(typeof plan === "string" ? { plan } : {}),
    at: new Date().toISOString(),
  };
}

/** The exchange code the secret refreshes itself with (the platform runs it in a jail whose only
 *  egress is the secret's pin): on a 401 from ChatGPT, trade the refresh token for new tokens.
 *  OpenAI rotates the refresh token, so the answer's is kept; the platform keeps what this returns. */
export const EXCHANGE_SOURCE: string = `const ISSUER = ${JSON.stringify(ISSUER)};
const CLIENT_ID = ${JSON.stringify(CLIENT_ID)};
const claims = (jwt) => {
  try {
    const part = String(jwt).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
  } catch {
    return {};
  }
};
export async function exchange(material, fetch) {
  if (!material.refreshToken) throw new Error("the secret holds no refresh token");
  const response = await fetch(ISSUER + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: material.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = (body.error && body.error.code) || body.code || body.error || "";
    throw new Error(
      "ChatGPT refused the refresh (" + response.status + (typeof code === "string" && code ? " " + code : "") +
        "): sign in again on the Connect ChatGPT page",
    );
  }
  const tokens = await response.json();
  if (!tokens.access_token) throw new Error("ChatGPT's refresh answered with no access token");
  const account = (claims(tokens.id_token)["https://api.openai.com/auth"] || {}).chatgpt_account_id;
  return {
    ...material,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || material.refreshToken,
    accountId: account || material.accountId,
  };
}
`;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Ask OpenAI for a device code. The person opens `VERIFICATION_URL`, signs in and types it. */
export async function startLogin(itx: Pick<ChatgptItx, "fetch" | "kv">): Promise<Pending> {
  const response = await itx.fetch(
    new Request(`${ISSUER}/api/accounts/deviceauth/usercode`, json({ client_id: CLIENT_ID })),
  );
  if (response.status === 404)
    throw new Error(
      "ChatGPT has device code sign-in switched off for this account. In ChatGPT, open Settings, Security, and turn on device code authorization for Codex. A workspace admin may have to turn it on.",
    );
  if (!response.ok) throw new Error(`ChatGPT would not start a sign-in (HTTP ${response.status})`);
  const body = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
  };
  const userCode = body.user_code ?? body.usercode;
  if (!body.device_auth_id || !userCode) throw new Error("ChatGPT answered with no device code");
  const pending: Pending = {
    deviceAuthId: body.device_auth_id,
    userCode,
    interval: Math.max(Number(body.interval) || 5, 2),
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

/** Keep a signed-in account: its tokens as the secret (pinned to ChatGPT and OpenAI's sign-in,
 *  refreshed by `EXCHANGE_SOURCE`), and who it is in the kv. */
export async function connect(itx: ChatgptItx, tokens: Tokens): Promise<Account> {
  const account = accountOf(tokens);
  await itx.secrets.set(
    SECRET,
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: account.accountId,
    },
    { urls: PIN, refresh: { kind: "worker", source: EXCHANGE_SOURCE } },
  );
  await itx.kv.put(ACCOUNT_KEY, JSON.stringify(account));
  await itx.kv.delete(PENDING_KEY);
  return account;
}

export type Poll = { status: "none" | "waiting" } | { status: "connected"; account: Account };

/** One look at a sign-in in progress. Waiting while the person has not typed the code (OpenAI
 *  answers 403 or 404); once they have, the authorization code becomes tokens and they are kept. */
export async function pollLogin(itx: ChatgptItx): Promise<Poll> {
  const pending = await readPending(itx);
  if (!pending) return { status: "none" };
  const answer = await itx.fetch(
    new Request(
      `${ISSUER}/api/accounts/deviceauth/token`,
      json({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
    ),
  );
  if (answer.status === 403 || answer.status === 404) return { status: "waiting" };
  if (!answer.ok) {
    await itx.kv.delete(PENDING_KEY);
    throw new Error(`ChatGPT's sign-in failed (HTTP ${answer.status}). Start again.`);
  }
  const code = (await answer.json()) as { authorization_code: string; code_verifier: string };
  const exchanged = await itx.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code.authorization_code,
        redirect_uri: `${ISSUER}/deviceauth/callback`,
        client_id: CLIENT_ID,
        code_verifier: code.code_verifier,
      }).toString(),
    }),
  );
  if (!exchanged.ok) {
    await itx.kv.delete(PENDING_KEY);
    throw new Error(`ChatGPT would not hand over tokens (HTTP ${exchanged.status}). Start again.`);
  }
  const tokens = (await exchanged.json()) as {
    id_token: string;
    access_token: string;
    refresh_token: string;
  };
  return {
    status: "connected",
    account: await connect(itx, {
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    }),
  };
}

export async function disconnect(itx: ChatgptItx): Promise<void> {
  await itx.secrets.delete(SECRET).catch(() => undefined);
  await itx.kv.delete(ACCOUNT_KEY);
  await itx.kv.delete(PENDING_KEY);
}

export async function isConnected(itx: Pick<ChatgptItx, "secrets">): Promise<boolean> {
  return (await itx.secrets.list()).some((secret) => secret.path === SECRET);
}

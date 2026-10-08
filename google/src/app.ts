/** What `itx.secrets.beginOAuth` takes (iterate/api `SecretOAuthOptions`), as this package passes
 *  it. */
export type OAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** A placeholder naming the secret that holds it: the platform reads it there at the code
   *  exchange and at every refresh, so it never passes through this code. */
  clientSecret: string;
  /** The package's own callback: a place in the project, which the platform turns into the
   *  redirect URI under the deployment's ingress. */
  redirect: { routingSlug: string; path: string };
  clientAuth?: "client_secret_basic" | "client_secret_post";
  scope: string;
  /** The origins the tokens may be sent to: the token endpoint's, and the APIs'. */
  urls: string[];
  extra?: Record<string, string>;
  /** The account the tokens must be for, by its id at the provider: another account's tokens are
   *  refused before anything is stored. */
  expectAccount?: string;
};

/** The project, as this package uses it: what a config worker's `itx` already has. */
export type GoogleItx = {
  /** The project's own kv: only the root has it (a sub-context's `kv` is denied by default). */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  secrets: {
    delete(path: string): Promise<unknown>;
    list(): Promise<{ path: string }[]>;
    collectFromUser(input: {
      path: string;
      egress: { urls: string[] };
      description?: string;
      fields?: { name: string; label: string; multiline?: boolean }[];
    }): Promise<{ path: string; url: string }>;
    beginOAuth(path: string, options: OAuthOptions): Promise<{ authorizationUrl: string }>;
    completeOAuth(
      path: string,
      input: { code: string; state: string },
    ): Promise<{ path: string; scopes: string[] }>;
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** What `google()` was given, with the package's own scopes and origins: the routing slug the
 *  Dash's buttons and the redirect lead to, every scope a connection asks for, and every origin its
 *  tokens may be sent to. */
export type Settings = { slug: string; scopes: string[]; urls: string[] };

/** EVERY NAME THE PACKAGE KEEPS STARTS WITH `own-google`: its secrets and its kv keys. The
 *  platform's shared Google client owns every `/secrets/google-<connection>` and
 *  `/integrations/google/<connection>`, for any connection name a member or an agent chooses, so a
 *  project that uses both would collide on any `google-` name. Its routing slug and its card on the
 *  Dash stay `google`: the shared client has no project host, and the registry is the packages'
 *  own. */

/** The OAuth client's secret, `clientSecret`, collected on the Dash so it never passes through this
 *  code. */
export const APP_SECRET = "/secrets/own-google-app";
/** Where the client secret may go: Google's token endpoint, which the platform sends it to at the
 *  code exchange and at every refresh. */
export const APP_PIN: string[] = ["https://oauth2.googleapis.com"];
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";
/** The scopes every connection asks for, whatever more it asks: `openid` and `email` name the
 *  account, at the userinfo endpoint and in the ID token that holds a reconnect to it. */
export const SCOPES: string[] = ["openid", "email", "profile"];
/** The origins every account's tokens may be sent to: the token endpoint, and Google's APIs on
 *  www.googleapis.com (userinfo, Calendar, Drive) and gmail.googleapis.com. */
export const URLS: string[] = [
  "https://oauth2.googleapis.com",
  "https://www.googleapis.com",
  "https://gmail.googleapis.com",
];
/** Google's token answer names the account (its ID token's `sub`, the userinfo `id`), so the
 *  platform holds a reconnect to its account (`expectAccount`): another account's tokens are
 *  refused before they are stored. */
const HOLDS_ACCOUNT = true;

/** An account's secret: its tokens, which the platform refreshes with the client's secret. */
export const secretOf = (connection: string): string => `/secrets/own-google-${connection}`;
/** What a request to Google's APIs sends for an account's token, in a header: iterate's egress
 *  swaps in the token. */
export const placeholder = (connection: string): string =>
  `getSecret("${secretOf(connection)}", { field: "accessToken" })`;

/** The kv: `own-google/app` (the client ID, public, and the redirect URI the platform last sent
 *  Google), `own-google/pending/<digest of the state>` (a sign-in this page started),
 *  `own-google/accounts/<connection>` (an account), and `own-google/removed/<connection>` (a
 *  removal whose null row has yet to land on the Dash). */
export const APP_KEY = "own-google/app";
const PENDING = "own-google/pending/";
export const ACCOUNTS = "own-google/accounts/";
export const REMOVED = "own-google/removed/";
/** How long a sign-in the page started can come back: the platform's attempt lasts as long. */
const ATTEMPT_TTL_MS = 60 * 60 * 1000;

/** A connection: eight hex digits, made when an account is first connected. */
export const CONNECTION: RegExp = /^[0-9a-f]{8}$/;

/** The client ID, and the redirect URI the platform sent Google with the last Connect when it was
 *  not the page's own address: a project with a primary hostname serves the page there, but the
 *  platform composes the redirect under iterate's ingress. */
export type App = { clientId: string; redirectUri?: string };
/** What the kv keeps of an account: its address, its id at Google, the scopes Google granted, and
 *  when it was connected. */
export type Account = { account: string; externalId: string; scopes: string[]; at: string };
/** A sign-in the page started: the connection it is for, and when. */
export type Attempt = { connection: string; at: number };
/** What a callback came to: the account connected, with the connections of the same account it
 *  replaced; or a reconnect's tokens refused, with the connection that went with them. */
export type Outcome =
  | { connected: string; replaced: string[] }
  | { refused: string; forgotten: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** Delete a secret. One that is already gone (`SECRET_NOT_SET`) is what was wanted; any other
 *  failure is thrown, so nothing reports a credential gone while it still works. A secret with
 *  only an attempt in flight is never set: the delete ends the attempt. */
export async function dropSecret(itx: Pick<GoogleItx, "secrets">, path: string): Promise<void> {
  await itx.secrets.delete(path).catch((error: unknown) => {
    if (codeOf(error) !== "SECRET_NOT_SET") throw error;
  });
}

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const hex = (bytes: number): string => hexOf(crypto.getRandomValues(new Uint8Array(bytes)));

/** The kv key of an attempt: the `state` is a token the platform signs, a few hundred characters
 *  long, so the key holds its SHA-256. */
const pendingKey = async (state: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return `${PENDING}${hexOf(new Uint8Array(digest))}`;
};

export async function readApp(itx: Pick<GoogleItx, "kv">): Promise<App | null> {
  const value = await itx.kv.get(APP_KEY);
  return value ? (JSON.parse(value) as App) : null;
}

/** Keep the client ID. It is public: it goes into the authorization URL. */
export async function saveApp(itx: Pick<GoogleItx, "kv">, clientId: string): Promise<App> {
  const id = clientId.trim();
  if (!/^\d{1,30}-[0-9a-z]{1,64}\.apps\.googleusercontent\.com$/.test(id))
    throw new Error(
      "The client ID ends in .apps.googleusercontent.com: it is on the client's page at Google",
    );
  const app: App = { ...(await readApp(itx)), clientId: id };
  await itx.kv.put(APP_KEY, JSON.stringify(app));
  return app;
}

export async function hasAppSecret(itx: Pick<GoogleItx, "secrets">): Promise<boolean> {
  return (await itx.secrets.list()).some((secret) => secret.path === APP_SECRET);
}

export async function readAccount(
  itx: Pick<GoogleItx, "kv">,
  connection: string,
): Promise<Account | null> {
  const value = await itx.kv.get(`${ACCOUNTS}${connection}`);
  return value ? (JSON.parse(value) as Account) : null;
}

/** Every account the kv keeps, with its connection. */
export async function listAccounts(
  itx: Pick<GoogleItx, "kv">,
): Promise<(Account & { connection: string })[]> {
  const found: (Account & { connection: string })[] = [];
  for (const key of (await itx.kv.list(ACCOUNTS)).keys) {
    const value = await itx.kv.get(key);
    if (value)
      found.push({ ...(JSON.parse(value) as Account), connection: key.slice(ACCOUNTS.length) });
  }
  return found;
}

/** The scopes as a person reads them: Google's URL prefix taken off. */
export const scopesShown = (scopes: string[]): string[] =>
  scopes.map((scope) => scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ""));

/** What Connect begins OAuth with, and Reconnect with `existing`: held to its account, which Google
 *  is also hinted to ask for. Google issues a refresh token only with offline access and the
 *  consent screen. */
function oauthOptionsOf(app: App, settings: Settings, existing: Account | null): OAuthOptions {
  return {
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: app.clientId,
    clientSecret: `getSecret("${APP_SECRET}", { field: "clientSecret" })`,
    redirect: { routingSlug: settings.slug, path: "/oauth2/callback" },
    scope: settings.scopes.join(" "),
    urls: settings.urls,
    extra: {
      access_type: "offline",
      prompt: "consent",
      ...(existing && { login_hint: existing.account }),
    },
    ...(existing && { expectAccount: existing.externalId }),
  };
}

/** Names the account a secret's token is for, with one call to Google's userinfo through the
 *  project's egress, which swaps the token in for the placeholder: the account's address, and its
 *  id at Google. */
async function nameAccount(path: string): Promise<{ account: string; externalId: string }> {
  const response = await fetch(
    new Request(USERINFO, {
      headers: { authorization: `Bearer getSecret("${path}", { field: "accessToken" })` },
    }),
  );
  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
    email?: unknown;
    error?: { message?: unknown };
  } | null;
  const id = body?.id;
  if (!response.ok || typeof id !== "string" || !id) {
    const message = typeof body?.error?.message === "string" ? `: ${body.error.message}` : "";
    throw new Error(`Google's userinfo named no account (HTTP ${response.status}${message})`);
  }
  return {
    account: typeof body?.email === "string" && body.email ? body.email : id,
    externalId: id,
  };
}

/** Begin OAuth for an account: a new connection, or `connection` again (Reconnect). Answers the URL
 *  to send the person to. The attempt is kept by its `state`, the query parameter the platform
 *  signed into that URL and Google sends back to the callback. It needs the client ID and the
 *  client secret: the platform refuses a placeholder that names no secret. */
export async function startConnect(
  itx: GoogleItx,
  settings: Settings,
  connection?: string,
): Promise<string> {
  const app = await readApp(itx);
  if (!app) throw new Error("Save the client ID first");
  if (!(await hasAppSecret(itx))) throw new Error("Save the client secret first");
  const existing = connection === undefined ? null : await readAccount(itx, connection);
  if (connection !== undefined && !existing) throw new Error("Unknown account");
  // a sign-in that never came back leaves its attempt behind: those over an hour old go
  for (const key of (await itx.kv.list(PENDING)).keys) {
    const value = await itx.kv.get(key);
    if (!value || Date.now() - (JSON.parse(value) as Attempt).at >= ATTEMPT_TTL_MS)
      await itx.kv.delete(key);
  }
  let id = connection ?? hex(4);
  // a new connection's id is one no account and no removal has
  if (connection === undefined)
    while (
      (await itx.kv.get(`${ACCOUNTS}${id}`)) !== null ||
      (await itx.kv.get(`${REMOVED}${id}`)) !== null
    )
      id = hex(4);
  const { authorizationUrl } = await itx.secrets.beginOAuth(
    secretOf(id),
    oauthOptionsOf(app, settings, existing),
  );
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) throw new Error("The platform's authorization URL carries no state");
  const attempt: Attempt = { connection: id, at: Date.now() };
  await itx.kv.put(await pendingKey(state), JSON.stringify(attempt));
  const redirectUri = url.searchParams.get("redirect_uri");
  if (redirectUri && redirectUri !== app.redirectUri)
    await itx.kv.put(APP_KEY, JSON.stringify({ ...app, redirectUri }));
  return authorizationUrl;
}

/** The attempt `state` names, while it is under an hour old: null for any other, which the
 *  callback refuses before it writes anything. */
export async function attemptOf(
  itx: Pick<GoogleItx, "kv">,
  state: string,
): Promise<Attempt | null> {
  if (!state) return null;
  const value = await itx.kv.get(await pendingKey(state));
  const attempt = value ? (JSON.parse(value) as Attempt) : null;
  return attempt && CONNECTION.test(attempt.connection) && Date.now() - attempt.at < ATTEMPT_TTL_MS
    ? attempt
    : null;
}

/** Forget an attempt that came back without a code (the person said no at Google): its kv entry,
 *  and a new connection's pending secret, which ends the attempt. A reconnected account keeps its
 *  tokens. */
export async function dropAttempt(itx: GoogleItx, state: string, attempt: Attempt): Promise<void> {
  await itx.kv.delete(await pendingKey(state));
  if (!(await readAccount(itx, attempt.connection)))
    await dropSecret(itx, secretOf(attempt.connection));
}

/** Finish an attempt the page started. The platform exchanges the code inside the secret's facet
 *  (the page never sees a token), one call names the account, and the kv keeps it. A connection
 *  of the same account made before goes: one row per account.
 *
 *  What fails is undone as far as it went. An exchange that fails stores nothing: a new
 *  connection's pending secret goes, and a reconnected one keeps its old tokens. Tokens that no
 *  account can be named for go with a new connection. A reconnect's new tokens replaced its old
 *  ones: they stay when the platform held them to its account (`HOLDS_ACCOUNT`); when it could not,
 *  tokens that may be another account's go, and the connection with them. */
export async function connectAccount(
  itx: GoogleItx,
  state: string,
  code: string,
  attempt: Attempt,
): Promise<Outcome> {
  const { connection } = attempt;
  const path = secretOf(connection);
  const existing = await readAccount(itx, connection);
  await itx.kv.delete(await pendingKey(state)); // tidying only: the platform says whether a state is good
  const undo = async (error: unknown): Promise<never> => {
    if (!existing)
      await dropSecret(itx, path).catch((leftover: unknown) => {
        throw new Error(`${messageOf(error)}; ${path} is left: ${messageOf(leftover)}`);
      });
    throw error;
  };
  const refuse = async (why: string, held: Account): Promise<Outcome> => {
    await forget(itx, connection).catch((leftover: unknown) => {
      throw new Error(`${why}; ${path} is left: ${messageOf(leftover)}`);
    });
    return {
      refused: `${why}. Those tokens were deleted, and ${held.account} is no longer connected: sign in to Google as ${held.account}, then connect it again.`,
      forgotten: connection,
    };
  };
  const { scopes } = await itx.secrets.completeOAuth(path, { code, state }).catch(undo);
  let named: { account: string; externalId: string };
  try {
    named = await nameAccount(path);
  } catch (error) {
    if (existing && !HOLDS_ACCOUNT) return await refuse(messageOf(error), existing);
    return await undo(error);
  }
  if (existing && named.externalId !== existing.externalId)
    return await refuse(`Google signed in ${named.account}, not ${existing.account}`, existing);
  const account: Account = { ...named, scopes, at: new Date().toISOString() };
  // connected again after a removal that did not finish: that removal is over
  await itx.kv.delete(`${REMOVED}${connection}`);
  await itx.kv.put(`${ACCOUNTS}${connection}`, JSON.stringify(account));
  const replaced: string[] = [];
  for (const other of await listAccounts(itx))
    if (other.connection !== connection && other.externalId === account.externalId) {
      await forget(itx, other.connection);
      replaced.push(other.connection);
    }
  return { connected: account.account, replaced };
}

/** Forget a connection here: its secret first, then its kv entry. A secret that cannot be deleted
 *  is thrown, and the entry stays, so the row stays and another try can work. From the moment the
 *  secret is gone until the null row has landed on the Dash, a tombstone,
 *  `own-google/removed/<connection>`, says what is left to do (`registerRemoval`); the install hook
 *  finishes any it finds. The access stays granted at Google until the account removes it. */
export async function forget(itx: GoogleItx, connection: string): Promise<void> {
  await dropSecret(itx, secretOf(connection));
  await itx.kv.put(`${REMOVED}${connection}`, JSON.stringify({ at: new Date().toISOString() }));
  await itx.kv.delete(`${ACCOUNTS}${connection}`);
}

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
  /** The origins the tokens may be sent to: the token endpoint's, and the API's. */
  urls: string[];
  extra?: Record<string, string>;
  /** Where the provider names the account the new tokens are for: an endpoint within `urls`, which
   *  the platform calls once with the new access token before it stores anything, and the JSON
   *  paths of the account's id and name. `completeOAuth` answers the account. */
  account: { url: string; id: string; name?: string };
  /** The account the tokens must be for, by the id `account`'s endpoint names: the platform refuses
   *  another account's tokens before it stores anything (`IDENTITY_CONFLICT`). */
  expectAccount?: string;
};

/** The project, as this package uses it: what a config worker's `itx` already has. */
export type CloudflareItx = {
  /** The project's own kv: only the root has it (a sub-context's `kv` is denied by default). */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  secrets: {
    delete(path: string): Promise<unknown>;
    /** The catalog: each secret's path, and the values of its public fields, never a secret one. */
    list(): Promise<{ path: string; public?: Record<string, string> }[]>;
    collectFromUser(input: {
      path: string;
      egress: { urls: string[] };
      description?: string;
      /** A `public` field is no secret: the form shows it as a plain input (with `placeholder`,
       *  and HTML's `pattern`), and the catalog answers its value. */
      fields?: {
        name: string;
        label: string;
        multiline?: boolean;
        public?: boolean;
        placeholder?: string;
        pattern?: string;
      }[];
      /** Where the Dash's form sends the person once it is saved. */
      redirectUrl?: string;
    }): Promise<{ path: string; url: string }>;
    beginOAuth(path: string, options: OAuthOptions): Promise<{ authorizationUrl: string }>;
    completeOAuth(
      path: string,
      input: { code: string; state: string },
    ): Promise<{ path: string; scopes: string[]; account?: { id: string; name: string | null } }>;
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** What `cloudflare()` was given, with the package's own scopes and origins: the routing slug the
 *  Dash's buttons and the redirect lead to, every scope a connection asks for, and every origin its
 *  tokens may be sent to. */
export type Settings = { slug: string; scopes: string[]; urls: string[] };

/** EVERY NAME THE PACKAGE KEEPS STARTS WITH `own-cloudflare`: its secrets and its kv keys. The
 *  platform's shared Cloudflare client owns every `/secrets/cloudflare-<connection>` and
 *  `/integrations/cloudflare/<connection>`, for any connection name a member or an agent chooses,
 *  so a project that uses both would collide on any `cloudflare-` name. Its routing slug and its
 *  card on the Dash stay `cloudflare`: the shared client has no project host, and the registry is
 *  the packages' own. */

/** The OAuth client, one secret: `clientId`, a public field, and `clientSecret`. A person enters both
 *  on one form of the Dash, so the secret never passes through this code. The catalog answers the
 *  client ID (`readApp`): the package keeps no copy of it. */
export const APP_SECRET = "/secrets/own-cloudflare-app";
/** Where the client may go: Cloudflare's token endpoint, which the platform sends it to at the code
 *  exchange and at every refresh. */
export const APP_PIN: string[] = ["https://dash.cloudflare.com"];
const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
/** Where Cloudflare names the person a token is for: the API's `/user`, whose `result.id` is the
 *  user's id and `result.email` the address. The platform calls it with the new token before it
 *  stores anything. Which ACCOUNT the token reaches is the one picked at consent: the API's
 *  `/accounts` lists it, and the package keeps it with the connection (`accountsOf`). */
const ACCOUNT = {
  url: "https://api.cloudflare.com/client/v4/user",
  id: "result.id",
  name: "result.email",
};
const ACCOUNTS_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts?per_page=50";
/** The scopes every connection asks for, whatever more it asks: `user-details.read` names the
 *  person at `/user`, and `offline_access` brings a refresh token. */
export const SCOPES: string[] = ["user-details.read", "offline_access"];
/** The scopes a deploy of iterate's platform into the account needs (core/os's Alchemy stack:
 *  the Worker, its routes, D1, KV, R2, the container application and its images, the Artifacts
 *  namespace, the account's state store in the Secrets Store), as `cloudflare({ scopes:
 *  DEPLOY_SCOPES })` asks for them. Cloudflare grants a token for the one account the person picks
 *  at consent. */
export const DEPLOY_SCOPES: string[] = [
  "account-settings.read",
  "memberships.read",
  "workers-scripts.write",
  "workers-kv-storage.write",
  "workers-r2.write",
  "d1.write",
  "artifacts.write",
  "containers.write",
  "cloudchamber.write",
  "workers-routes.write",
  "zone.read",
  "workers-tail.read",
  "workers-observability.read",
  "pipelines.read",
  "ai.write",
  "browser-rendering.write",
  "email-sending.write",
  "images.write",
  "secrets-store.write",
];
/** The origins every account's tokens may be sent to: the token endpoint's, and the API. */
export const URLS: string[] = ["https://dash.cloudflare.com", "https://api.cloudflare.com"];

/** An account's secret: its tokens, which the platform refreshes with the client's secret. */
export const secretOf = (connection: string): string => `/secrets/own-cloudflare-${connection}`;
/** What a request to Cloudflare's API sends for a connection's token, in a header: iterate's
 *  egress swaps in the token. */
export const placeholder = (connection: string): string =>
  `getSecret("${secretOf(connection)}", { field: "accessToken" })`;

/** The kv: `own-cloudflare/redirect-uri` (the redirect URI the platform last sent Cloudflare),
 *  `own-cloudflare/pending/<digest of the state>` (a sign-in this page started),
 *  `own-cloudflare/accounts/<connection>` (a connection), and `own-cloudflare/removed/<connection>`
 *  (a removal whose null row has yet to land on the Dash). */
export const REDIRECT_URI = "own-cloudflare/redirect-uri";
const PENDING = "own-cloudflare/pending/";
export const ACCOUNTS = "own-cloudflare/accounts/";
export const REMOVED = "own-cloudflare/removed/";
/** How long a sign-in the page started can come back: the platform's attempt lasts as long. */
const ATTEMPT_TTL_MS = 60 * 60 * 1000;

/** A connection: eight hex digits, made when a person is first connected. */
export const CONNECTION: RegExp = /^[0-9a-f]{8}$/;

/** The client, as the catalog answers it: its ID, the public field of `APP_SECRET`. */
export type App = { clientId: string };
/** A Cloudflare account the connection's token reaches: its id, as every API route names it, and
 *  its name. */
export type CloudflareAccount = { id: string; name: string };
/** What the kv keeps of a connection: the person's address, their id at Cloudflare, the scopes
 *  Cloudflare granted, the accounts the token reaches, and when it was connected. */
export type Account = {
  account: string;
  externalId: string;
  scopes: string[];
  accounts: CloudflareAccount[];
  at: string;
};
/** A sign-in the page started: the connection it is for, and when. */
export type Attempt = { connection: string; at: number };
/** What a callback came to: the person connected, with the connections of the same person it
 *  replaced. */
export type Outcome = { connected: string; replaced: string[] };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** Delete a secret. One that is already gone (`SECRET_NOT_SET`) is what was wanted; any other
 *  failure is thrown, so nothing reports a credential gone while it still works. A secret with
 *  only an attempt in flight is never set: the delete ends the attempt. */
export async function dropSecret(itx: Pick<CloudflareItx, "secrets">, path: string): Promise<void> {
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

/** The client, from the catalog: null until `APP_SECRET` holds its ID as a public field. A secret
 *  there without it (set by hand, or saved before the form asked for the ID) is not a client: the
 *  page asks to save the client again. */
export async function readApp(itx: Pick<CloudflareItx, "secrets">): Promise<App | null> {
  const entry = (await itx.secrets.list()).find((secret) => secret.path === APP_SECRET);
  const clientId = entry?.public?.clientId;
  return clientId ? { clientId } : null;
}

/** Whether the project has a secret at `APP_SECRET`, a client or not. */
export async function hasAppSecret(itx: Pick<CloudflareItx, "secrets">): Promise<boolean> {
  return (await itx.secrets.list()).some((secret) => secret.path === APP_SECRET);
}

export async function readAccount(
  itx: Pick<CloudflareItx, "kv">,
  connection: string,
): Promise<Account | null> {
  const value = await itx.kv.get(`${ACCOUNTS}${connection}`);
  return value ? (JSON.parse(value) as Account) : null;
}

/** Every connection the kv keeps. */
export async function listAccounts(
  itx: Pick<CloudflareItx, "kv">,
): Promise<(Account & { connection: string })[]> {
  const found: (Account & { connection: string })[] = [];
  for (const key of (await itx.kv.list(ACCOUNTS)).keys) {
    const value = await itx.kv.get(key);
    if (value)
      found.push({ ...(JSON.parse(value) as Account), connection: key.slice(ACCOUNTS.length) });
  }
  return found;
}

/** The Cloudflare accounts a connection's token reaches, from the API, as the project's egress
 *  sends it (the placeholder in the header; iterate swaps the token in). An answer that is not a
 *  list, or no answer, is none: the connection stands, and the page says so. */
export async function accountsOf(connection: string): Promise<CloudflareAccount[]> {
  try {
    const response = await fetch(ACCOUNTS_ENDPOINT, {
      headers: { authorization: `Bearer ${placeholder(connection)}` },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { result?: unknown };
    if (!Array.isArray(body.result)) return [];
    return body.result.flatMap((entry: unknown) => {
      const row = entry as { id?: unknown; name?: unknown };
      return typeof row.id === "string"
        ? [{ id: row.id, name: typeof row.name === "string" ? row.name : row.id }]
        : [];
    });
  } catch {
    return [];
  }
}

/** What Connect begins OAuth with, and Reconnect with `existing`: held to its person by the id
 *  `/user` names. Cloudflare takes the client's secret in the token request's body. */
function oauthOptionsOf(app: App, settings: Settings, existing: Account | null): OAuthOptions {
  return {
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: app.clientId,
    clientSecret: `getSecret("${APP_SECRET}", { field: "clientSecret" })`,
    redirect: { routingSlug: settings.slug, path: "/oauth2/callback" },
    clientAuth: "client_secret_post",
    scope: settings.scopes.join(" "),
    urls: settings.urls,
    account: ACCOUNT,
    ...(existing && { expectAccount: existing.externalId }),
  };
}

/** Begin OAuth for a person: a new connection, or `connection` again (Reconnect). Answers the URL
 *  to send the person to. The attempt is kept by its `state`, the query parameter the platform
 *  signed into that URL and Cloudflare sends back to the callback. It needs the client. The
 *  redirect URI the platform sent is kept when it changes: a project with a primary hostname
 *  serves the page there, but the platform composes the redirect under iterate's ingress, and the
 *  page shows it. */
export async function startConnect(
  itx: CloudflareItx,
  settings: Settings,
  connection?: string,
): Promise<string> {
  const app = await readApp(itx);
  if (!app) throw new Error("Save the client first");
  const existing = connection === undefined ? null : await readAccount(itx, connection);
  if (connection !== undefined && !existing) throw new Error("Unknown connection");
  // a sign-in that never came back leaves its attempt behind: those over an hour old go
  for (const key of (await itx.kv.list(PENDING)).keys) {
    const value = await itx.kv.get(key);
    if (!value || Date.now() - (JSON.parse(value) as Attempt).at >= ATTEMPT_TTL_MS)
      await itx.kv.delete(key);
  }
  let id = connection ?? hex(4);
  // a new connection's id is one no connection and no removal has
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
  if (redirectUri && redirectUri !== (await itx.kv.get(REDIRECT_URI)))
    await itx.kv.put(REDIRECT_URI, redirectUri);
  return authorizationUrl;
}

/** The attempt `state` names, while it is under an hour old: null for any other, which the
 *  callback refuses before it writes anything. */
export async function attemptOf(
  itx: Pick<CloudflareItx, "kv">,
  state: string,
): Promise<Attempt | null> {
  if (!state) return null;
  const value = await itx.kv.get(await pendingKey(state));
  const attempt = value ? (JSON.parse(value) as Attempt) : null;
  return attempt && CONNECTION.test(attempt.connection) && Date.now() - attempt.at < ATTEMPT_TTL_MS
    ? attempt
    : null;
}

/** Forget an attempt that came back without a code (the person said no at Cloudflare): its kv
 *  entry, and a new connection's pending secret, which ends the attempt. A reconnected connection
 *  keeps its tokens. */
export async function dropAttempt(
  itx: CloudflareItx,
  state: string,
  attempt: Attempt,
): Promise<void> {
  await itx.kv.delete(await pendingKey(state));
  if (!(await readAccount(itx, attempt.connection)))
    await dropSecret(itx, secretOf(attempt.connection));
}

/** Finish an attempt the page started. The platform exchanges the code inside the secret's facet
 *  (the page never sees a token), names the person at `/user` before it stores the tokens, and
 *  refuses a reconnect's tokens for another person (`IDENTITY_CONFLICT`). The kv keeps the person
 *  it names, and the accounts the token reaches. A connection of the same person made before
 *  goes: one row per person.
 *
 *  An exchange that fails or is refused stores nothing: a new connection's pending secret goes, and
 *  a reconnected one keeps its old tokens. Tokens the platform names no person for go with a new
 *  connection. */
export async function connectAccount(
  itx: CloudflareItx,
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
  const { scopes, account: named } = await itx.secrets
    .completeOAuth(path, { code, state })
    .catch(undo);
  if (!named) return await undo(new Error("The platform named no account for these tokens"));
  const account: Account = {
    account: named.name ?? named.id,
    externalId: named.id,
    scopes,
    accounts: await accountsOf(connection),
    at: new Date().toISOString(),
  };
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
 *  `own-cloudflare/removed/<connection>`, says what is left to do (`registerRemoval`); the install
 *  hook finishes any it finds. The grant stays at Cloudflare until the person revokes it. */
export async function forget(itx: CloudflareItx, connection: string): Promise<void> {
  await dropSecret(itx, secretOf(connection));
  await itx.kv.put(`${REMOVED}${connection}`, JSON.stringify({ at: new Date().toISOString() }));
  await itx.kv.delete(`${ACCOUNTS}${connection}`);
}

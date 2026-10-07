/** The refresh strategy the platform mints an installation's token with (iterate/api
 *  `SecretRefresh`): `POST <apiOrigin>/app/installations/<id>/access_tokens` with a JWT signed by the
 *  App's key, on first use and on a 401. */
export type InstallationRefresh = {
  kind: "github-app-installation";
  apiOrigin: string;
  installationId: string;
  client: { project: "github" };
};

/** The project, as this package uses it: what a config worker's `itx` already has. */
export type GithubItx = {
  fetch(request: Request): Promise<Response>;
  /** The project's own kv: only the root has it (a sub-context's `kv` is denied by default). */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  secrets: {
    set(
      path: string,
      material: string | Record<string, unknown>,
      options: { urls: string[]; refresh?: InstallationRefresh },
    ): Promise<unknown>;
    delete(path: string): Promise<unknown>;
    list(): Promise<{ path: string }[]>;
    verifyHmac(
      path: string,
      input: { payload: string | Uint8Array; signature: string; field?: string },
    ): Promise<boolean>;
    collectFromUser(input: {
      path: string;
      egress: { urls: string[] };
      description?: string;
      fields?: { name: string; label: string; multiline?: boolean }[];
    }): Promise<{ path: string; url: string }>;
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** The App's own secret: `privateKey` (the PEM GitHub generated) and `webhookSecret` (the one typed
 *  in the App's settings), collected on the Dash so neither passes through this code. */
export const APP_SECRET = "/secrets/github-app";
/** Where the App's secrets and every installation's token may go. */
export const PIN: string[] = ["https://github.com", "https://api.github.com"];
const API = "https://api.github.com";

/** An installation's secret: the App ID and a placeholder for the App's key, from which the
 *  platform mints the installation's token (`accessToken`). */
export const secretOf = (installationId: string): string => `/secrets/github-${installationId}`;
/** What a request to GitHub's API sends for an installation's token, in a header: iterate's egress
 *  swaps in the token, minted by the platform. */
export const placeholder = (installationId: string): string =>
  `getSecret("${secretOf(installationId)}", { field: "accessToken" })`;
/** The stream each installation's webhook deliveries are recorded on. */
export const streamOf = (installationId: string): string =>
  `/integrations/github/${installationId}`;

/** The kv: `github/app` (the App's ID and slug, both public), `github/pending/<nonce>` (an install
 *  this page started), `github/installations/<connection>` (an installation, by its id, or a
 *  request an owner has yet to approve, `request-<…>`), and `github/removed/<connection>` (a
 *  removal whose null row has yet to land on the Dash). */
export const APP_KEY = "github/app";
const PENDING = "github/pending/";
export const INSTALLATIONS = "github/installations/";
export const REMOVED = "github/removed/";
/** How long an install the page started can come back. */
const NONCE_TTL_MS = 60 * 60 * 1000;
/** Where each nonce is claimed, once (`claimNonce`). */
const CLAIMS = "/integrations/github";

/** An installation id, as GitHub sends it to the setup URL and in a delivery's body. */
export const INSTALLATION_ID: RegExp = /^\d{1,20}$/;
/** A connection on the Dash: an installation id, or a request an owner has yet to approve. */
export const CONNECTION: RegExp = /^(?:\d{1,20}|request-[0-9a-f]{16})$/;

export type App = { appId: string; slug: string };
/** What the kv keeps of an installation: the account it is on (`installation <id>` when GitHub did
 *  not say), and when it was connected. A request an owner has yet to approve also keeps the nonce
 *  of the install that asked: GitHub comes back with it once the owner approves. */
export type Installation = { account: string; at: string; requested?: true; nonce?: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** Delete a secret. One that is already gone (`SECRET_NOT_SET`) is what was wanted; any other
 *  failure is thrown, so nothing reports a credential gone while it still works. */
export async function dropSecret(itx: Pick<GithubItx, "secrets">, path: string): Promise<void> {
  await itx.secrets.delete(path).catch((error: unknown) => {
    if (codeOf(error) !== "SECRET_NOT_SET") throw error;
  });
}

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function readApp(itx: Pick<GithubItx, "kv">): Promise<App | null> {
  const value = await itx.kv.get(APP_KEY);
  return value ? (JSON.parse(value) as App) : null;
}

/** Keep the App's ID and slug. The slug may come as the App's public link,
 *  `https://github.com/apps/<slug>`. */
export async function saveApp(
  itx: Pick<GithubItx, "kv">,
  appId: string,
  slugOrLink: string,
): Promise<App> {
  const id = appId.trim();
  if (!/^\d{1,12}$/.test(id)) throw new Error("The App ID is a number: it is on the App's page");
  const slug =
    /^https:\/\/github\.com\/apps\/([^/?#]+)\/?$/.exec(slugOrLink.trim())?.[1] ?? slugOrLink.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug))
    throw new Error("The slug is the last part of the App's public link, github.com/apps/<slug>");
  const app = { appId: id, slug };
  await itx.kv.put(APP_KEY, JSON.stringify(app));
  return app;
}

export async function hasAppSecret(itx: Pick<GithubItx, "secrets">): Promise<boolean> {
  return (await itx.secrets.list()).some((secret) => secret.path === APP_SECRET);
}

/** Every installation and request the kv keeps, with its connection. */
export async function listInstallations(
  itx: Pick<GithubItx, "kv">,
): Promise<(Installation & { connection: string })[]> {
  const found: (Installation & { connection: string })[] = [];
  for (const key of (await itx.kv.list(INSTALLATIONS)).keys) {
    const value = await itx.kv.get(key);
    if (value)
      found.push({
        ...(JSON.parse(value) as Installation),
        connection: key.slice(INSTALLATIONS.length),
      });
  }
  return found;
}

/** The link that installs the App, with a nonce that binds GitHub's redirect back to this install
 *  (`state`, which GitHub passes through to the setup URL). It needs the App's ID and slug, and its
 *  secrets: the callback proves the installation with them. */
export async function startInstall(itx: Pick<GithubItx, "kv" | "secrets">): Promise<string> {
  const app = await readApp(itx);
  if (!app) throw new Error("Save the App ID and slug first");
  if (!(await hasAppSecret(itx)))
    throw new Error("Save the App's private key and webhook secret first");
  // an install that never came back leaves its nonce behind: those over an hour old go
  for (const key of (await itx.kv.list(PENDING)).keys) {
    const value = await itx.kv.get(key);
    if (!value || Date.now() - (JSON.parse(value) as { at: number }).at >= NONCE_TTL_MS)
      await itx.kv.delete(key);
  }
  const nonce = hex(16);
  await itx.kv.put(`${PENDING}${nonce}`, JSON.stringify({ at: Date.now() }));
  return `https://github.com/apps/${app.slug}/installations/new?state=${nonce}`;
}

/** The connection of the request a nonce started: `request-` and the nonce's first 16 digits. */
export const requestOf = (nonce: string): string => `request-${nonce.slice(0, 16)}`;

/** Whether this page issued `nonce`: for an install it started within the hour, or for a request an
 *  owner has yet to approve, which keeps its nonce until GitHub comes back with it. Null for any
 *  other; else the request it answers, if one. Issued is not unused: `claimNonce` decides that. */
export async function issuedNonce(
  itx: Pick<GithubItx, "kv">,
  nonce: string,
): Promise<{ request: string | null } | null> {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return null;
  const asked = await itx.kv.get(`${INSTALLATIONS}${requestOf(nonce)}`);
  if (asked && (JSON.parse(asked) as Installation).nonce === nonce)
    return { request: requestOf(nonce) };
  const pending = await itx.kv.get(`${PENDING}${nonce}`);
  const fresh = pending && Date.now() - (JSON.parse(pending) as { at: number }).at < NONCE_TTL_MS;
  return fresh ? { request: null } : null;
}

/** Claim a nonce for one installation, once: true for the first claim, false for any other. The kv
 *  cannot claim anything (two callbacks both read a nonce before either deletes it, and a delete
 *  answers `{ ok: true }` whatever was there), so the claim is an append keyed by the nonce, whose
 *  body only this claim has: the first lands, and any other is an IDEMPOTENCY_CONFLICT. (Two claims
 *  with one body would both pass: the same event again is a no-op.) */
export async function claimNonce(itx: GithubItx, nonce: string): Promise<boolean> {
  try {
    await itx.cd(CLAIMS).append({
      type: "github/nonce-used",
      idempotencyKey: `github:nonce:${nonce}`,
      payload: { nonce, claim: hex(16) },
    });
  } catch (error) {
    if (codeOf(error) === "IDEMPOTENCY_CONFLICT") return false;
    throw error;
  }
  await itx.kv.delete(`${PENDING}${nonce}`); // tidying only: the claim is the event
  return true;
}

/** The one call that proves an installation's secret works, and names the account it is on: the
 *  owner of its first repository. */
async function prove(itx: GithubItx, path: string, installationId: string): Promise<string> {
  const response = await itx.fetch(
    new Request(`${API}/installation/repositories?per_page=1`, {
      headers: {
        authorization: `Bearer getSecret("${path}", { field: "accessToken" })`,
        accept: "application/vnd.github+json",
        "user-agent": "iterate",
      },
    }),
  );
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    repositories?: { owner?: { login?: string } }[];
  } | null;
  if (!response.ok)
    throw new Error(
      `GitHub refused installation ${installationId} (HTTP ${response.status}${body?.message ? `: ${body.message}` : ""})`,
    );
  return body?.repositories?.[0]?.owner?.login ?? `installation ${installationId}`;
}

/** Record an installation GitHub sent back: its secret, proved by one call that also names the
 *  account, and the kv entry. The proof runs on a secret of its own, `/secrets/github-<id>-proof`,
 *  and the installation's secret is set only once it has passed: an update that fails (GitHub down,
 *  a wrong App ID saved) leaves a working installation as it was, its minted token included. The
 *  proof's secret goes either way, and a failure to delete it is said.
 *
 *  The secret holds the App ID and a placeholder for the App's key, which the platform reads from
 *  `/secrets/github-app` at each mint: one App secret serves every installation. No proof that the
 *  person administers the account is needed: the project owns the App and holds its key, so it can
 *  mint for any installation of its App already. */
export async function connectInstallation(itx: GithubItx, installationId: string): Promise<string> {
  const app = await readApp(itx);
  if (!app) throw new Error("Save the App ID and slug first");
  const material = {
    appId: app.appId,
    privateKey: `getSecret("${APP_SECRET}", { field: "privateKey" })`,
  };
  const options = {
    urls: PIN,
    refresh: {
      kind: "github-app-installation" as const,
      apiOrigin: API,
      installationId,
      client: { project: "github" as const },
    },
  };
  const proof = `${secretOf(installationId)}-proof`;
  await itx.secrets.set(proof, material, options);
  let account: string;
  try {
    account = await prove(itx, proof, installationId);
  } catch (error) {
    await dropSecret(itx, proof).catch((leftover: unknown) => {
      throw new Error(`${messageOf(error)}; ${proof} is left: ${messageOf(leftover)}`);
    });
    throw error;
  }
  await dropSecret(itx, proof);
  await itx.secrets.set(secretOf(installationId), material, options);
  // connected again after a removal that did not finish: that removal is over
  await itx.kv.delete(`${REMOVED}${installationId}`);
  const installation: Installation = { account, at: new Date().toISOString() };
  await itx.kv.put(`${INSTALLATIONS}${installationId}`, JSON.stringify(installation));
  return account;
}

/** Record an installation an owner has yet to approve. GitHub names no installation for it (it
 *  sends `setup_action=request` and the `state` alone), so its connection is made from the nonce,
 *  which it keeps: when the owner approves, GitHub comes back with that nonce, however much later.
 *  Answers the connection. */
export async function recordRequest(itx: Pick<GithubItx, "kv">, nonce: string): Promise<string> {
  const connection = requestOf(nonce);
  const request: Installation = {
    account: "An installation request",
    at: new Date().toISOString(),
    requested: true,
    nonce,
  };
  await itx.kv.delete(`${REMOVED}${connection}`);
  await itx.kv.put(`${INSTALLATIONS}${connection}`, JSON.stringify(request));
  await itx.kv.delete(`${PENDING}${nonce}`); // the request keeps the nonce from here
  return connection;
}

/** Forget a connection here: an installation's secret first, then its kv entry. A secret that
 *  cannot be deleted is thrown, and the entry stays, so the row stays and another try can work.
 *  From the moment the secret is gone until the null row has landed on the Dash, a tombstone,
 *  `github/removed/<connection>`, says what is left to do (`registerRemoval`); the install hook
 *  finishes any it finds. The App stays installed at GitHub. */
export async function forget(itx: GithubItx, connection: string): Promise<void> {
  if (INSTALLATION_ID.test(connection)) await dropSecret(itx, secretOf(connection));
  await itx.kv.put(`${REMOVED}${connection}`, JSON.stringify({ at: new Date().toISOString() }));
  await itx.kv.delete(`${INSTALLATIONS}${connection}`);
}

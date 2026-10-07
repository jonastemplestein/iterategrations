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
 *  request an owner has yet to approve, `request-<…>`). */
export const APP_KEY = "github/app";
const PENDING = "github/pending/";
export const INSTALLATIONS = "github/installations/";
/** How long an install the page started can come back. */
const NONCE_TTL_MS = 60 * 60 * 1000;

/** An installation id, as GitHub sends it to the setup URL and in a delivery's body. */
export const INSTALLATION_ID: RegExp = /^\d{1,20}$/;
/** A connection on the Dash: an installation id, or a request an owner has yet to approve. */
export const CONNECTION: RegExp = /^(?:\d{1,20}|request-[0-9a-f]{16})$/;

export type App = { appId: string; slug: string };
/** What the kv keeps of an installation: the account it is on (`installation <id>` when GitHub did
 *  not say), when it was connected, and whether it waits on an owner's approval. */
export type Installation = { account: string; at: string; requested?: true };

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

/** Spend a nonce: true if this page issued it within the hour (and now it is gone). */
export async function spendNonce(itx: Pick<GithubItx, "kv">, nonce: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
  const value = await itx.kv.get(`${PENDING}${nonce}`);
  if (!value) return false;
  await itx.kv.delete(`${PENDING}${nonce}`);
  return Date.now() - (JSON.parse(value) as { at: number }).at < NONCE_TTL_MS;
}

/** Record an installation GitHub sent back: its secret, one proof call that also names the account,
 *  and the kv entry. A proof that fails throws, and deletes the secret again unless the installation
 *  was connected before (an update): a failure at GitHub must not break one that works.
 *
 *  The secret holds the App ID and a placeholder for the App's key, which the platform reads from
 *  `/secrets/github-app` at each mint: one App secret serves every installation. No proof that the
 *  person administers the account is needed: the project owns the App and holds its key, so it can
 *  mint for any installation of its App already. */
export async function connectInstallation(itx: GithubItx, installationId: string): Promise<string> {
  const app = await readApp(itx);
  if (!app) throw new Error("Save the App ID and slug first");
  const path = secretOf(installationId);
  const known = (await itx.kv.get(`${INSTALLATIONS}${installationId}`)) !== null;
  await itx.secrets.set(
    path,
    { appId: app.appId, privateKey: `getSecret("${APP_SECRET}", { field: "privateKey" })` },
    {
      urls: PIN,
      refresh: {
        kind: "github-app-installation",
        apiOrigin: API,
        installationId,
        client: { project: "github" },
      },
    },
  );
  let account: string;
  try {
    const response = await itx.fetch(
      new Request(`${API}/installation/repositories?per_page=1`, {
        headers: {
          authorization: `Bearer ${placeholder(installationId)}`,
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
    account = body?.repositories?.[0]?.owner?.login ?? `installation ${installationId}`;
  } catch (error) {
    if (!known) await itx.secrets.delete(path).catch(() => undefined);
    throw error;
  }
  const installation: Installation = { account, at: new Date().toISOString() };
  await itx.kv.put(`${INSTALLATIONS}${installationId}`, JSON.stringify(installation));
  return account;
}

/** Record an installation an owner has yet to approve. GitHub names no installation for it (it
 *  sends `setup_action=request` and the `state` alone), so its connection is made from the
 *  nonce. Answers the connection. */
export async function recordRequest(itx: Pick<GithubItx, "kv">, nonce: string): Promise<string> {
  const connection = `request-${nonce.slice(0, 16)}`;
  const request: Installation = {
    account: "An installation request",
    at: new Date().toISOString(),
    requested: true,
  };
  await itx.kv.put(`${INSTALLATIONS}${connection}`, JSON.stringify(request));
  return connection;
}

/** Forget an installation here: its secret and its kv entry. The App stays installed at GitHub. */
export async function forget(itx: GithubItx, connection: string): Promise<void> {
  if (INSTALLATION_ID.test(connection))
    await itx.secrets.delete(secretOf(connection)).catch(() => undefined);
  await itx.kv.delete(`${INSTALLATIONS}${connection}`);
}

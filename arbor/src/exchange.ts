/** ARBOR'S LOGIN, as a secret's exchange code (`refresh: { kind: "worker", source: EXCHANGE_SOURCE }`):
 *  iterate's secret facet calls it on first use and on a 401 with the secret's material
 *  `{ username, password, site }` (and, after the first call, the `accessToken` and `refreshToken`
 *  it returned), and a `fetch` that reaches the secret's pinned origins only. It keeps the object
 *  it returns.
 *
 *  This is the Arbor parent app's login: OAuth2 at Arbor's central login, `login.arbor.sc`, with
 *  the app's client ID. It tries the refresh token first, as the app does, and logs in with the
 *  password when there is none or Arbor refuses it. The answer lists the account's schools; the
 *  secret's `site` must be one of them, so a wrong or missing site fails here with the right ones.
 *
 *  Self-contained on purpose (no imports, every constant inside): `EXCHANGE_SOURCE` is this
 *  function's own text, run in a jail that has nothing else. */
export async function exchange(
  material: {
    username?: string;
    password?: string;
    site?: string;
    refreshToken?: string;
    [field: string]: unknown;
  },
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Record<string, unknown>> {
  const tokenUrl = "https://login.arbor.sc/oauth2/token";
  const clientId = "ARBOR_PARENT_APP";
  const { username, password, site, refreshToken } = material;
  if (typeof username !== "string" || !username || typeof password !== "string" || !password)
    throw new Error('arbor: the secret\'s material has no "username" and "password"');
  const post = (body: Record<string, string>) =>
    fetch(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "okhttp/4.12.0",
      },
      body: JSON.stringify(body),
    });
  type Answer = {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    schools?: { baseUrl?: unknown }[];
  } | null;
  const refreshed =
    typeof refreshToken === "string" && refreshToken
      ? await post({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        })
      : null;
  // a refused refresh token (HTTP 400, invalid_grant) is no failure: the password logs in again
  const renewed = (refreshed?.ok ? await refreshed.json().catch(() => null) : null) as Answer;
  // (no block statements in this function: the test runner's transform would change its text)
  const login = renewed?.access_token
    ? null
    : await post({
        grant_type: "password",
        username,
        password,
        client_id: clientId,
        scope: "GUARDIAN",
      });
  const loggedIn = (login ? await login.json().catch(() => null) : null) as Answer;
  if (login && !login.ok)
    throw new Error(
      `arbor: login refused (HTTP ${login.status}${typeof loggedIn?.error === "string" ? `, ${loggedIn.error.slice(0, 40)}` : ""}): check the secret's username and password`,
    );
  const answer = login ? loggedIn : renewed;
  if (!answer?.access_token) throw new Error("arbor: login returned no access_token");
  const trim = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
  const sites = (Array.isArray(answer.schools) ? answer.schools : [])
    .map((school) => (typeof school?.baseUrl === "string" ? trim(school.baseUrl) : ""))
    .filter(Boolean);
  const wanted = typeof site === "string" ? trim(site) : "";
  if (!sites.includes(wanted))
    throw new Error(
      `arbor: ${wanted ? `the secret's site ${wanted} is not` : 'the secret has no "site", which must be'} one of this account's schools: ${sites.join(", ") || "none"}`,
    );
  return {
    ...material,
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? refreshToken,
  };
}

/** The exchange as the module text a secret's `refresh.source` takes. */
export const EXCHANGE_SOURCE: string = `export ${exchange.toString()}`;

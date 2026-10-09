import {
  ACCOUNTS,
  APP_PIN,
  APP_SECRET,
  CONNECTION,
  REDIRECT_URI,
  REMOVED,
  attemptOf,
  connectAccount,
  dropAttempt,
  forget,
  hasAppSecret,
  listAccounts,
  readApp,
  secretOf,
  startConnect,
  type CloudflareItx,
  type Settings,
} from "./app.js";
import { accountsShown, registerCard, registerRemoval, registerRow } from "./registry.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

const STYLE = `
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
  section { border: 1px solid #8884; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  input, button { font: inherit; padding: .5rem .75rem; border-radius: 8px; border: 1px solid #8886; }
  input { width: 100%; box-sizing: border-box; margin: .25rem 0; }
  button, .button { cursor: pointer; background: #f6821f; color: #fff; border-color: #f6821f; text-decoration: none; display: inline-block; padding: .5rem .75rem; border-radius: 8px; }
  button.quiet { background: none; color: inherit; border-color: #8886; }
  .error { background: #c0392b22; border: 1px solid #c0392b; border-radius: 8px; padding: .5rem .75rem; }
  .ok { background: #27ae6022; border: 1px solid #27ae60; border-radius: 8px; padding: .5rem .75rem; }
  .warn { background: #e67e2222; border: 1px solid #e67e22; border-radius: 8px; padding: .5rem .75rem; }
  .row { display: flex; gap: .5rem; align-items: center; justify-content: space-between; padding: .25rem 0; }
  .muted { opacity: .7; font-size: .9rem; } code { word-break: break-all; }
  pre { white-space: pre-wrap; word-break: break-all; background: #8881; border-radius: 8px; padding: .5rem .75rem; font-size: .85rem; }
  form { display: inline; } form.block { display: block; }
  .copy { display: flex; gap: .5rem; align-items: center; margin: .25rem 0 .5rem; }
  .copy code { flex: 1; min-width: 0; }
  li { margin: .35rem 0; }
`;

/** Wires every [data-copy] button to the clipboard. It runs under a nonce: the page allows no other script. */
const COPY_SCRIPT = `document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const text = button.getAttribute("data-copy");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = label), 1500);
});`;

const copyRow = (text: string): string =>
  `<div class="copy"><code>${esc(text)}</code><button type="button" class="quiet" data-copy="${esc(text)}">Copy</button></div>`;

const post = (action: string, fields: Record<string, string>, label: string, quiet = false) =>
  `<form method="post" action="${action}">${Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}" />`)
    .join("")}<button${quiet ? ' class="quiet"' : ""}>${label}</button></form>`;

/** No other site may show these pages in a frame: a framed form posts from this origin, so the
 *  member gate passes (clickjacking). `default-src` does not cover `frame-ancestors`. Every answer
 *  carries both, the page's and the callback's alike. */
const NO_FRAMES = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
} as const;

const redirect = (query = ""): Response =>
  new Response(null, { status: 303, headers: { location: `./${query}`, ...NO_FRAMES } });
const notFound = (): Response => new Response("Not found\n", { status: 404, headers: NO_FRAMES });
const flashOf = (key: "error" | "connected", text: string): string =>
  `?${key}=${encodeURIComponent(text)}`;
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the collection page on the Dash shows the person, above its two fields. */
const COLLECT_DESCRIPTION = `Your Cloudflare OAuth client: its ID and its secret.

- **Client ID:** 32 hex characters, as Cloudflare answered when the client was created.
- **Client secret:** answered once, beside the ID, when the client was created. If it is lost, create the client again.

The platform sends the secret only to Cloudflare's token endpoint, when it exchanges a code for a person's tokens and when it refreshes them. It never passes through the project's code.`;

/** The client's two fields: its ID, public, in the shape Cloudflare gives it (HTML's `pattern`,
 *  which the browser compiles with the `v` flag), and its secret. */
const FIELDS = [
  {
    name: "clientId",
    label: "Client ID",
    public: true,
    placeholder: "0123456789abcdef0123456789abcdef",
    pattern: String.raw`[0-9a-f]{32}`,
  },
  { name: "clientSecret", label: "Client secret" },
];

/** The link to the Dash's page that collects the client into `/secrets/own-cloudflare-app`, on one
 *  form, which sends the person back to this page once it is saved. It only builds a URL, so the
 *  page asks for a fresh one each time it renders. */
const collectLink = (itx: CloudflareItx, here: string): Promise<string> =>
  itx.secrets
    .collectFromUser({
      path: APP_SECRET,
      egress: { urls: APP_PIN },
      description: COLLECT_DESCRIPTION,
      fields: FIELDS,
      redirectUrl: `${here}/`,
    })
    .then((link) => link.url);

/** The request that registers an OAuth client on an account, for the person to run with an API
 *  token of their own: Cloudflare's dashboard has no form for it on every account. */
const registration = (callback: string, scopes: string[]): string =>
  `curl -X POST "https://api.cloudflare.com/client/v4/accounts/<account id>/oauth_clients" \\
  -H "Authorization: Bearer <an API token with OAuth Clients Write>" \\
  -H "Content-Type: application/json" \\
  --data '${JSON.stringify({
    client_name: "iterate",
    redirect_uris: [callback],
    scopes,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  })}'`;

async function render(
  itx: CloudflareItx,
  settings: Settings,
  here: string,
  flash: string,
): Promise<string> {
  const app = await readApp(itx);
  // a secret saved without the public client ID: by hand, or before the form asked for it
  const incomplete = !app && (await hasAppSecret(itx));
  const link = await collectLink(itx, here).catch((error: unknown) => ({
    failed: messageOf(error),
  }));
  const accounts = await listAccounts(itx);
  const callback = `${here}/oauth2/callback`;
  const redirectUri = await itx.kv.get(REDIRECT_URI);
  const sent =
    redirectUri && redirectUri !== callback
      ? `<p class="warn">With the last Connect, the platform sent Cloudflare this one, the project's address under iterate's ingress: a hostname claimed on the Dash never replaces it. Register it too:</p>${copyRow(redirectUri)}`
      : "";
  const step1 = `<section>
    <h2>1. Create the OAuth client</h2>
    <p>An OAuth client belongs to a Cloudflare account; the people who connect here may be on any account. Register one on yours with the API (the <a href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/">API token</a> needs <b>OAuth Clients Write</b>), with this redirect URI, exactly:${copyRow(callback)}${sent}</p>
    <pre>${esc(registration(callback, settings.scopes))}</pre>
    <p>The answer carries the client's <b>id</b> and its <b>secret</b>, once: keep them for step 2. Cloudflare's dashboard shows the client afterwards under the account's OAuth clients, where its redirect URIs and scopes can be changed.</p>
  </section>`;
  const step2 = `<section>
    <h2>2. Save the client</h2>
    ${
      app
        ? `<p class="ok">Client ID ${esc(app.clientId)}</p>`
        : incomplete
          ? `<p class="warn">The project's secret <code>${APP_SECRET}</code> has no public client ID. Save the client again: the form asks for the ID and the secret together.</p>`
          : ""
    }
    ${
      typeof link === "string"
        ? `<p><a class="button" href="${esc(link)}">${app ? "Replace it" : "Save the client"}</a></p>${copyRow(link)}`
        : `<p class="error">The project could not make the link: ${esc(link.failed)}</p>`
    }
    <p class="muted">The link opens a page of iterate's Dash, which asks for the client ID and the client secret, and keeps them as <code>${APP_SECRET}</code>, pinned to dash.cloudflare.com. The secret never passes through this page.</p>
  </section>`;
  const step3 = `<section>
    <h2>3. Connect an account</h2>
    ${
      app
        ? `<p>${post("connect", {}, "Connect an account")}</p><p class="muted">Cloudflare asks which account the person grants access to, and for their consent, then sends them back here. Connect again to add another person or account.</p>`
        : `<p class="muted">First save the client (2).</p>`
    }
    <p class="muted">It asks Cloudflare for ${settings.scopes.map((scope) => `<code>${esc(scope)}</code>`).join(" ")}.</p>
  </section>`;
  const list = accounts.length
    ? accounts
        .map(
          (account) =>
            `<div class="row"><span><b>${esc(account.account)}</b> <span class="muted">on ${esc(accountsShown(account))}<br /><code>${esc(secretOf(account.connection))}</code>, since ${esc(account.at.slice(0, 10))}<br />${esc(account.scopes.join(" "))}</span></span><span>${post("connect", { id: account.connection }, "Reconnect", true)} ${post("disconnect", { id: account.connection }, "Disconnect", true)}</span></div>`,
        )
        .join("")
    : `<p class="muted">None yet.</p>`;
  const listed = `<section>
    <h2>Connections</h2>
    ${list}
    <p class="muted">Reconnect asks Cloudflare again for the same person: for more scopes, another account, or when the refresh token has stopped working. Disconnect deletes the connection's secret and forgets it here. The grant stays at Cloudflare until the person revokes it in their <a href="https://dash.cloudflare.com/profile">profile</a>.</p>
  </section>`;
  return `${flash}${step1}${step2}${step3}${listed}`;
}

/** The members-only page at `/`: the redirect URI to register at Cloudflare, the link that
 *  collects the client on the Dash, Connect, and the connections with Reconnect and Disconnect.
 *  Every write is a plain form POST, answered with a redirect back to the page; Connect's and
 *  Reconnect's go on to Cloudflare. */
export async function servePage(
  request: Request,
  itx: CloudflareItx,
  settings: Settings,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\//, "");

  if (request.method === "GET" && path === "") {
    // the redirect URI keeps the base path a paths ingress strips
    const here = `${url.origin}${request.headers.get("x-iterate-base-path") || ""}`;
    const error = url.searchParams.get("error");
    const connected = url.searchParams.get("connected");
    const flash = error
      ? `<p class="error">${esc(error)}</p>`
      : connected
        ? `<p class="ok">Connected ${esc(connected)}. The project's code and agents can now call Cloudflare's API as this person, on the account they picked.</p>`
        : "";
    const body = await render(itx, settings, here, flash);
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Cloudflare</title><style>${STYLE}</style></head><body><h1>Cloudflare</h1>${body}<script nonce="${nonce}">${COPY_SCRIPT}</script></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": NO_FRAMES["x-frame-options"],
          // Connect posts here and is sent on to Cloudflare, so a form may lead there too
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self' https://dash.cloudflare.com; base-uri 'none'; frame-ancestors 'none'`,
        },
      },
    );
  }
  if (request.method !== "POST") return notFound();

  const form = await request.formData();
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  try {
    if (path === "connect") {
      // Connect makes a connection; Reconnect names the one it asks again for
      const connection = field("id");
      if (connection && !CONNECTION.test(connection))
        return redirect(flashOf("error", "Unknown connection"));
      return new Response(null, {
        status: 303,
        headers: {
          location: await startConnect(itx, settings, connection || undefined),
          ...NO_FRAMES,
        },
      });
    }
    if (path === "disconnect") {
      // a connection, or a removal that did not finish: Disconnect again finishes it
      const connection = field("id");
      const known =
        CONNECTION.test(connection) &&
        ((await itx.kv.get(`${ACCOUNTS}${connection}`)) !== null ||
          (await itx.kv.get(`${REMOVED}${connection}`)) !== null);
      if (!known) return redirect(flashOf("error", "Unknown connection"));
      await forget(itx, connection);
      await registerRemoval(itx, settings.slug, connection);
      await registerCard(itx, settings.slug);
      return redirect();
    }
    return notFound();
  } catch (error) {
    return redirect(flashOf("error", messageOf(error)));
  }
}

/** Cloudflare's return, `/oauth2/callback`, members only: the person comes back from the consent
 *  screen with `code` and `state`, or with `error` when they said no. Anyone can open this URL with
 *  any query, so a state this page kept, under an hour old, is required before anything is
 *  written. The platform checks the state itself and exchanges the code once: the same callback
 *  again answers the same. The card goes before the row: a row stands under its card alone. */
export async function serveCallback(
  request: Request,
  itx: CloudflareItx,
  settings: Settings,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("GET only\n", { status: 405, headers: NO_FRAMES });
  const query = new URL(request.url).searchParams;
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  const back = (flash: string): Response =>
    new Response(null, { status: 303, headers: { location: `../${flash}`, ...NO_FRAMES } });
  const attempt = await attemptOf(itx, state);
  if (!attempt)
    return back(
      flashOf(
        "error",
        "Cloudflare came back from a sign-in this page did not start, or that is over an hour old. Press Connect again.",
      ),
    );
  try {
    if (!code) {
      await dropAttempt(itx, state, attempt);
      return back(
        flashOf(
          "error",
          `Cloudflare answered ${query.get("error") || "with no code"}: nothing changed.`,
        ),
      );
    }
    const outcome = await connectAccount(itx, state, code, attempt);
    for (const connection of outcome.replaced)
      await registerRemoval(itx, settings.slug, connection);
    await registerCard(itx, settings.slug);
    await registerRow(itx, settings.slug, attempt.connection);
    return back(flashOf("connected", outcome.connected));
  } catch (error) {
    return back(flashOf("error", messageOf(error)));
  }
}

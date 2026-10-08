import {
  APP_SECRET,
  CONNECTION,
  INSTALLATION_ID,
  INSTALLATIONS,
  PIN,
  REMOVED,
  claimNonce,
  connectInstallation,
  forget,
  hasAppSecret,
  issuedNonce,
  listInstallations,
  readApp,
  recordRequest,
  startInstall,
  type GithubItx,
} from "./app.js";
import { registerCard, registerRemoval, registerRow } from "./registry.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

const STYLE = `
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
  section { border: 1px solid #8884; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  input, button { font: inherit; padding: .5rem .75rem; border-radius: 8px; border: 1px solid #8886; }
  input { width: 100%; box-sizing: border-box; margin: .25rem 0; }
  button, .button { cursor: pointer; background: #2a7de1; color: #fff; border-color: #2a7de1; text-decoration: none; display: inline-block; padding: .5rem .75rem; border-radius: 8px; }
  button.quiet { background: none; color: inherit; border-color: #8886; }
  .error { background: #c0392b22; border: 1px solid #c0392b; border-radius: 8px; padding: .5rem .75rem; }
  .ok { background: #27ae6022; border: 1px solid #27ae60; border-radius: 8px; padding: .5rem .75rem; }
  .warn { background: #e67e2222; border: 1px solid #e67e22; border-radius: 8px; padding: .5rem .75rem; }
  .row { display: flex; gap: .5rem; align-items: center; justify-content: space-between; padding: .25rem 0; }
  .muted { opacity: .7; font-size: .9rem; } code { word-break: break-all; }
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
const flashOf = (key: "error" | "connected" | "requested", text: string): string =>
  `?${key}=${encodeURIComponent(text)}`;
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the collection page on the Dash shows the person, above its four fields. */
const COLLECT_DESCRIPTION = `Your GitHub App: its ID and slug, its private key and its webhook secret.

- **App ID:** on the App's settings page at GitHub, under About.
- **Slug:** the end of the App's public link, \`https://github.com/apps/<slug>\`, on the same page.
- **Private key (.pem):** open the \`.pem\` file GitHub downloaded when you generated the key, in a text editor, and paste all of it, the BEGIN and END lines too.
- **Webhook secret:** the secret you typed under Webhook in the App's settings.

The key only signs the App's requests for installation tokens to GitHub's API, and the webhook secret only checks GitHub's deliveries. Neither passes through the project's code.`;

/** The App's four fields: its ID and its slug, public, each in the shape GitHub gives it (HTML's
 *  `pattern`, which the browser compiles with the `v` flag), then its key and its webhook secret. */
const FIELDS = [
  {
    name: "appId",
    label: "App ID",
    public: true,
    placeholder: "123456",
    pattern: String.raw`\d{1,12}`,
  },
  {
    name: "slug",
    label: "Slug: the end of github.com/apps/<slug>",
    public: true,
    pattern: String.raw`[a-z0-9][a-z0-9\-]{0,99}`,
  },
  { name: "privateKey", label: "Private key (.pem)", multiline: true },
  { name: "webhookSecret", label: "Webhook secret" },
];

/** The link to the Dash's page that collects the App into `/secrets/own-github-app`, on one form.
 *  It only builds a URL, so the page asks for a fresh one each time it renders. */
const collectLink = (itx: GithubItx): Promise<string> =>
  itx.secrets
    .collectFromUser({
      path: APP_SECRET,
      egress: { urls: PIN },
      description: COLLECT_DESCRIPTION,
      fields: FIELDS,
    })
    .then((link) => link.url);

/** Under Install: an installation that exists already, by its ID. GitHub comes back to the setup URL
 *  only after a new install or a change to one, so a project that moves to this package with its
 *  App installed connects the installation here. */
const CONNECT_FORM = `<p class="muted">Installed already? GitHub sends you back here only after a new install or a change to one. To connect an installation that exists, give its ID: the number at the end of its settings page, <code>github.com/settings/installations/&lt;id&gt;</code>, or for an organization <code>github.com/organizations/&lt;org&gt;/settings/installations/&lt;id&gt;</code>.</p>
    <form method="post" action="connect" class="block">
      <label for="installation-id">Installation ID</label>
      <input id="installation-id" name="id" inputmode="numeric" pattern="\\d{1,20}" placeholder="12345678" autocomplete="off" required />
      <button>Connect</button>
    </form>`;

async function render(itx: GithubItx, here: string, flash: string): Promise<string> {
  const app = await readApp(itx);
  // a secret saved without the public App ID and slug: by hand, or before the form asked for them
  const incomplete = !app && (await hasAppSecret(itx));
  const link = await collectLink(itx).catch((error: unknown) => ({ failed: messageOf(error) }));
  const installations = await listInstallations(itx);
  const step1 = `<section>
    <h2>1. Create the App</h2>
    <p>Open <a href="https://github.com/settings/apps/new">github.com/settings/apps/new</a> for your own account, or for an organization <code>github.com/organizations/&lt;org&gt;/settings/apps/new</code>. Fill in:</p>
    <ul>
      <li><b>GitHub App name:</b> any name that is free on GitHub; the project's is a good one.</li>
      <li><b>Homepage URL:</b> this page:${copyRow(`${here}/`)}</li>
      <li><b>Setup URL</b> (under Post installation), and tick <b>Redirect on update</b>:${copyRow(`${here}/oauth2/callback`)}</li>
      <li><b>Webhook:</b> Active. <b>Webhook URL:</b>${copyRow(`${here}/webhook`)}<b>Secret:</b> make one up (<code>openssl rand -hex 32</code>) and keep it for step 2.</li>
      <li><b>Permissions</b> and <b>Subscribe to events:</b> what the project needs, no more. Every event you subscribe to reaches the project.</li>
      <li><b>Where can this GitHub App be installed?</b> Only on this account, unless other accounts should install it.</li>
    </ul>
    <p>Press <b>Create GitHub App</b>. On the App's page, note its <b>App ID</b> and its public link (<code>https://github.com/apps/&lt;slug&gt;</code>), then press <b>Generate a private key</b>: GitHub downloads a <code>.pem</code> file. Keep them for step 2.</p>
  </section>`;
  const step2 = `<section>
    <h2>2. Save the App</h2>
    ${
      app
        ? `<p class="ok">App ${esc(app.appId)}, <a href="https://github.com/apps/${esc(app.slug)}">github.com/apps/${esc(app.slug)}</a></p>`
        : incomplete
          ? `<p class="warn">The project's secret <code>${APP_SECRET}</code> has no public App ID and slug. Save the App again: the form asks for all four values together.</p>`
          : ""
    }
    ${
      typeof link === "string"
        ? `<p><a class="button" href="${esc(link)}">${app ? "Replace it" : "Save the App"}</a></p>${copyRow(link)}`
        : `<p class="error">The project could not make the link: ${esc(link.failed)}</p>`
    }
    <p class="muted">The link opens a page of iterate's Dash, which asks for the App ID, the slug, the private key and the webhook secret, and keeps them as <code>${APP_SECRET}</code>, pinned to github.com and api.github.com. The key and the webhook secret never pass through this page.</p>
  </section>`;
  const step3 = `<section>
    <h2>3. Install it</h2>
    ${
      app
        ? `<p>${post("install", {}, "Install the App")}</p><p class="muted">GitHub asks which account, and which of its repositories, then sends you back here. Install again to add another account.</p>${CONNECT_FORM}`
        : `<p class="muted">First save the App (2).</p>`
    }
  </section>`;
  const list = installations.length
    ? installations
        .map((installation) =>
          installation.requested
            ? `<div class="row"><span>${esc(installation.account)} <span class="muted">awaiting an owner's approval since ${esc(installation.at.slice(0, 10))}</span></span>${post("disconnect", { id: installation.connection }, "Forget", true)}</div>`
            : `<div class="row"><span><b>${esc(installation.account)}</b> <span class="muted">installation ${esc(installation.connection)}, since ${esc(installation.at.slice(0, 10))}</span></span>${post("disconnect", { id: installation.connection }, "Disconnect", true)}</div>`,
        )
        .join("")
    : `<p class="muted">None yet.</p>`;
  const listed = `<section>
    <h2>Installations</h2>
    ${list}
    <p class="muted">Disconnect forgets an installation here and deletes its secret. The App stays installed at GitHub: only its account can uninstall it, in the account's settings under its installed GitHub Apps. A request waits for an owner of the account. When GitHub sends their approval back here, the request becomes the installation; if it does not, press Install again and Save on GitHub's page, then Forget the request.</p>
  </section>`;
  return `${flash}${step1}${step2}${step3}${listed}`;
}

/** The members-only page at `/`: the App's URLs to paste at GitHub, the link that collects the App
 *  on the Dash, Install, the form that connects an installation that exists already, and the
 *  installations with Disconnect. Every write is a plain form POST, answered with a redirect back to
 *  the page; Install's goes on to GitHub. `slug` is the routing slug the Dash's buttons lead to. */
export async function servePage(request: Request, itx: GithubItx, slug: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\//, "");

  if (request.method === "GET" && path === "") {
    // the URLs GitHub is given keep the base path a paths ingress strips
    const here = `${url.origin}${request.headers.get("x-iterate-base-path") || ""}`;
    const error = url.searchParams.get("error");
    const connected = url.searchParams.get("connected");
    const flash = error
      ? `<p class="error">${esc(error)}</p>`
      : connected
        ? `<p class="ok">Installed on ${esc(connected)}. Its webhook deliveries now reach the project.</p>`
        : url.searchParams.has("requested")
          ? `<p class="warn">GitHub asked an owner of that account to approve the App. The request waits below. When GitHub sends their approval back here, it becomes the installation.</p>`
          : "";
    const body = await render(itx, here, flash);
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>GitHub</title><style>${STYLE}</style></head><body><h1>GitHub</h1>${body}<script nonce="${nonce}">${COPY_SCRIPT}</script></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": NO_FRAMES["x-frame-options"],
          // Install posts here and is sent on to GitHub, so a form may lead there too
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'`,
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
    if (path === "install")
      return new Response(null, {
        status: 303,
        headers: { location: await startInstall(itx), ...NO_FRAMES },
      });
    if (path === "connect") {
      // an installation that exists already, by its ID: the proof through the App's key decides
      // whether it is the App's before its secret is set, as for an install GitHub sends back
      const id = field("id").trim();
      if (!INSTALLATION_ID.test(id))
        return redirect(
          flashOf(
            "error",
            "The installation ID is a number: the end of github.com/settings/installations/<id>",
          ),
        );
      const account = await connectInstallation(itx, id);
      await registerCard(itx, slug);
      await registerRow(itx, slug, id);
      return redirect(flashOf("connected", account));
    }
    if (path === "disconnect") {
      // an installation, a request, or a removal that did not finish: Disconnect again finishes it
      const connection = field("id");
      const known =
        CONNECTION.test(connection) &&
        ((await itx.kv.get(`${INSTALLATIONS}${connection}`)) !== null ||
          (await itx.kv.get(`${REMOVED}${connection}`)) !== null);
      if (!known) return redirect(flashOf("error", "Unknown installation"));
      await forget(itx, connection);
      await registerRemoval(itx, slug, connection);
      await registerCard(itx, slug);
      return redirect();
    }
    return notFound();
  } catch (error) {
    return redirect(flashOf("error", messageOf(error)));
  }
}

/** The App's setup URL, `/oauth2/callback`, members only. After an install GitHub sends the person here
 *  with `installation_id`, `setup_action` (`install`, `update`, or `request` when an owner must
 *  approve it, with no installation yet) and the `state` the install link carried
 *  (https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url,
 *  https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app). Anyone can open
 *  this URL with any `installation_id`, so a nonce this page issued is required: for an install it
 *  started within the hour, or for a request an owner has yet to approve. A request keeps its nonce;
 *  an installation claims its nonce once, before any secret is written, so two callbacks with one
 *  nonce never both go on. The request whose nonce comes back with an installation is answered, and
 *  only that one: the others wait for their own approval, or for Forget. */
export async function serveCallback(
  request: Request,
  itx: GithubItx,
  slug: string,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("GET only\n", { status: 405, headers: NO_FRAMES });
  const query = new URL(request.url).searchParams;
  const state = query.get("state") ?? "";
  const action = query.get("setup_action") ?? "";
  const id = query.get("installation_id") ?? "";
  const back = (flash: string): Response =>
    new Response(null, { status: 303, headers: { location: `../${flash}`, ...NO_FRAMES } });
  const refused = flashOf(
    "error",
    "GitHub came back from an install this page did not start, or that is over an hour old. Press Install again.",
  );
  const issued = await issuedNonce(itx, state);
  if (!issued) return back(refused);
  try {
    // the card before any row: a row stands under its card alone
    if (action === "request") {
      const connection = await recordRequest(itx, state);
      await registerCard(itx, slug);
      await registerRow(itx, slug, connection);
      return back(flashOf("requested", "1"));
    }
    if ((action === "install" || action === "update") && INSTALLATION_ID.test(id)) {
      if (!(await claimNonce(itx, state)))
        return back(flashOf("error", "GitHub came back with an install that was used already."));
      const account = await connectInstallation(itx, id);
      if (issued.request) {
        await forget(itx, issued.request);
        await registerRemoval(itx, slug, issued.request);
      }
      await registerCard(itx, slug);
      await registerRow(itx, slug, id);
      return back(flashOf("connected", account));
    }
    return back(flashOf("error", "GitHub sent back no installation. Press Install again."));
  } catch (error) {
    return back(flashOf("error", messageOf(error)));
  }
}

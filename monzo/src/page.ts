const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

const STYLE = `
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
  section { border: 1px solid #8884; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  button { font: inherit; cursor: pointer; padding: .5rem .75rem; border-radius: 8px; border: 1px solid #8886; }
  button.quiet { background: none; color: inherit; }
  .ok { background: #27ae6022; border: 1px solid #27ae60; border-radius: 8px; padding: .5rem .75rem; }
  .warn { background: #e67e2222; border: 1px solid #e67e22; border-radius: 8px; padding: .5rem .75rem; }
  .muted { opacity: .7; font-size: .9rem; } code { word-break: break-all; }
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

/** What the page shows: the card's title and sentence, the recipe, the sign-in's secret and whether
 *  it exists (as the install hook reads it), the prefix of each account's webhook secret, and the
 *  accounts whose webhook secret exists. The secrets list names them; it never holds a value. */
export type PageView = {
  title: string;
  description: string;
  recipe: string;
  signIn: string;
  signedIn: boolean;
  webhookSecrets: string;
  accounts: string[];
};

/** The members-only page at `/`: whether the sign-in exists, the accounts, the shape of an
 *  account's webhook URL, and the recipe. It writes nothing, so it has no form. */
export function servePage(request: Request, view: PageView): Response {
  const url = new URL(request.url);
  // the URL Monzo is given keeps the base path a paths ingress strips
  const here = `${url.origin}${request.headers.get("x-iterate-base-path") || ""}`;
  const status = view.signedIn
    ? `<p class="ok">Signed in. The project has the sign-in secret <code>${esc(view.signIn)}</code>.</p>`
    : `<p class="warn">Set up by your coding agent: see the recipe. The project has no sign-in secret <code>${esc(view.signIn)}</code> yet. Paste this into your coding agent:</p>${copyRow(`Set up ${view.title} in my iterate project. Follow the recipe at ${view.recipe}`)}`;
  const accounts = view.accounts.length
    ? `<ul>${view.accounts.map((name) => `<li><b>${esc(name)}</b> <span class="muted">events on <code>/monzo/${esc(name)}</code></span></li>`).join("")}</ul>`
    : `<p class="muted">None yet.</p>`;
  const body = `<p>${esc(view.description)}</p>
    <section><h2>Status</h2>${status}</section>
    <section>
      <h2>Accounts</h2>
      ${accounts}
      <p>An account is here once its webhook secret, <code>${esc(view.webhookSecrets)}&lt;account&gt;</code>, exists. Step 4 of the recipe makes the secret and registers the account's webhook with Monzo at this URL. Nobody pastes it, and the secret is never shown:</p>
      ${copyRow(`${here}/webhook/<account>/<secret>`)}
    </section>
    <p><a href="${esc(view.recipe)}">The recipe</a> on GitHub has every step.</p>`;
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${esc(view.title)}</title><style>${STYLE}</style></head><body><h1>${esc(view.title)}</h1>${body}<script nonce="${nonce}">${COPY_SCRIPT}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // no other site may frame it (default-src does not cover frame-ancestors)
        "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

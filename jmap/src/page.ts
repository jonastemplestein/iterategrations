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
  code { word-break: break-all; }
  .copy { display: flex; gap: .5rem; align-items: center; margin: .25rem 0 .5rem; }
  .copy code { flex: 1; min-width: 0; }
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

/** What the page shows: the card's title and sentence, the recipe, and the token's secret path and
 *  whether it exists, as the install hook reads it. The page never calls Fastmail, so it does not
 *  show the mailbox's address. */
export type PageView = {
  title: string;
  description: string;
  recipe: string;
  secret: string;
  saved: boolean;
};

/** The members-only page at `/`: whether the mailbox is set up, and the recipe. The mailbox has no
 *  webhook, so there is no URL to paste. It writes nothing, so it has no form. */
export function servePage(view: PageView): Response {
  const status = view.saved
    ? `<p class="ok">Set up. The project has the Fastmail API token <code>${esc(view.secret)}</code>.</p>`
    : `<p class="warn">Set up by your coding agent: see the recipe. The project has no Fastmail API token <code>${esc(view.secret)}</code> yet. Paste this into your coding agent:</p>${copyRow(`Set up ${view.title} in my iterate project. Follow the recipe at ${view.recipe}`)}`;
  const body = `<p>${esc(view.description)}</p>
    <section><h2>Status</h2>${status}</section>
    <p><a href="${esc(view.recipe)}">The recipe</a> on GitHub has every step, and every call to the mailbox.</p>`;
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

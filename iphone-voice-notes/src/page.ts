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
  a.button { display: inline-block; padding: .5rem .75rem; border-radius: 8px; border: 1px solid #8886; text-decoration: none; color: inherit; font-weight: 600; }
  ol { padding-left: 1.25rem; } li { margin: .5rem 0; }
  .note { margin: .5rem 0; } .note small { color: #888; display: block; }
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

/** One transcribed note, as the page lists it. */
export type PageNote = {
  receivedAt: string;
  transcript: string | null;
  error: string | null;
  test: boolean;
};

/** What the page shows: the card's title and sentence, the recipe, the token's secret path and
 *  whether it exists, as the install hook reads it, a link to set it (null when none could be
 *  made), the header the shortcut sends it in, and the newest notes. */
export type PageView = {
  title: string;
  description: string;
  recipe: string;
  secret: string;
  header: string;
  testHeader: string;
  saved: boolean;
  collectUrl: string | null;
  notes: PageNote[];
};

const noteRow = (note: PageNote): string =>
  `<div class="note"><small>${esc(note.receivedAt)}${note.test ? " · test" : ""}</small>${
    note.transcript === null
      ? `<i>Not transcribed: ${esc(note.error ?? "unknown error")}</i>`
      : note.transcript
        ? esc(note.transcript)
        : "<i>Nothing said</i>"
  }</div>`;

/** The members-only page at `/`: whether the token exists, with a link to set it; the newest
 *  notes; and every step of the shortcut, with the URL and header to copy. It writes nothing
 *  itself, so it has no form: the token is entered on the platform's own page. */
export function servePage(request: Request, view: PageView): Response {
  const url = new URL(request.url);
  // the URL the shortcut is given keeps the base path a paths ingress strips
  const here = `${url.origin}${request.headers.get("x-iterate-base-path") || ""}`;
  const collect = (label: string) =>
    view.collectUrl ? `<p><a class="button" href="${esc(view.collectUrl)}">${label}</a></p>` : "";
  const status = view.saved
    ? `<p class="ok">Set up. The project has the token <code>${esc(view.secret)}</code>.</p>${collect("Change the token")}`
    : `<p class="warn">Not set up yet: the project has no token <code>${esc(view.secret)}</code>. Make one up (a long random password from your password manager is best), save it here, and put the same value in the shortcut.</p>${collect("Set the token")}`;
  const notes = view.notes.length
    ? view.notes.map(noteRow).join("")
    : "<p>No notes yet. Reload this page a few seconds after you record one.</p>";
  const body = `<p>${esc(view.description)}</p>
    <section><h2>1. The token</h2>${status}</section>
    <section>
      <h2>2. The shortcut</h2>
      <p>On the iPhone, in the <b>Shortcuts</b> app:</p>
      <ol>
        <li>Tap <b>+</b> at the top right. Name the shortcut <b>Voice Note</b>.</li>
        <li>Add <b>Record Audio</b>. Tap its arrow and set <b>Audio Quality</b> to Normal, <b>Start Recording</b> to Immediately, and <b>Finish Recording</b> to On Tap.</li>
        <li>Add <b>Get Contents of URL</b>, and set its URL to:${copyRow(`${here}/webhook`)}</li>
        <li>Tap its arrow. Set <b>Method</b> to POST. Under <b>Headers</b>, tap <b>Add new header</b>: the key is${copyRow(view.header)}and the value is the token. Do not use <code>Authorization</code>: the project's host answers that header itself, so the token never reaches this receiver.</li>
        <li>Set <b>Request Body</b> to File, tap the <b>File</b> field, and choose <b>Recorded Audio</b>.</li>
        <li>Optional: add <b>Vibrate Device</b> at the end, to feel a buzz when the upload is in. A failed upload shows an error banner.</li>
        <li>Tap the play button once, while the phone is unlocked, and choose <b>Always Allow</b> for the microphone and for this domain. Otherwise those questions come up on the lock screen and stop the shortcut.</li>
      </ol>
      <p>Then, in <b>Settings</b>, <b>Action Button</b>: swipe to <b>Shortcut</b>, tap <b>Choose a Shortcut</b>, and choose <b>Voice Note</b>.</p>
      <p>To use it: hold the Action Button until it buzzes, speak, and tap stop. iOS does not tell a shortcut when the button is released, so a tap ends the note.</p>
      <p>Trying it out? Add a header <code>${esc(view.testHeader)}</code> with the value <code>true</code>: the note is stored and transcribed, and marked as a test, so a project that hands notes to its agents can skip it. Remove the header when it works.</p>
    </section>
    <section><h2>3. The newest notes</h2>${notes}</section>
    <p><a href="${esc(view.recipe)}">The recipe</a> on GitHub has every step, for a coding agent.</p>`;
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

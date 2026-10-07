import {
  disconnect,
  isConnected,
  pollLogin,
  readAccount,
  readPending,
  SECRET,
  startLogin,
  VERIFICATION_URL,
  type ChatgptItx,
  type WithItx,
} from "./auth.js";
import { chatgptModels, chatgptText } from "./request.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

const STYLE = `
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  section { border: 1px solid #8884; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  button, .button { font: inherit; cursor: pointer; background: #2a7de1; color: #fff; border: 1px solid #2a7de1; text-decoration: none; display: inline-block; padding: .5rem .75rem; border-radius: 8px; }
  button.quiet { background: none; color: inherit; border-color: #8886; }
  .error { background: #c0392b22; border: 1px solid #c0392b; border-radius: 8px; padding: .5rem .75rem; }
  .ok { background: #27ae6022; border: 1px solid #27ae60; border-radius: 8px; padding: .5rem .75rem; }
  .warn { background: #e67e2222; border: 1px solid #e67e22; border-radius: 8px; padding: .5rem .75rem; }
  .muted { opacity: .7; font-size: .9rem; } code, pre { word-break: break-all; white-space: pre-wrap; }
  .code { font: 2rem/1.2 ui-monospace, monospace; letter-spacing: .15em; margin: .5rem 0; }
  form { display: inline; }
`;

/** Polls `poll` until the sign-in finishes, then reloads. It runs under a nonce: the page allows no
 *  other script. Without it, the "Check now" button does the same by hand. */
const POLL_SCRIPT = (seconds: number): string => `const wait = ${Math.max(seconds, 2) * 1000};
const status = document.getElementById("status");
(async function poll() {
  try {
    const answer = await (await fetch("poll", { method: "POST", headers: { accept: "application/json" } })).json();
    if (answer.status === "connected" || answer.status === "none") return location.replace("./");
    if (answer.error) { status.textContent = answer.error; return; }
  } catch {}
  setTimeout(poll, wait);
})();`;

const post = (action: string, label: string, quiet = false): string =>
  `<form method="post" action="${action}"><button${quiet ? ' class="quiet"' : ""}>${label}</button></form>`;

const redirect = (query = ""): Response =>
  new Response(null, { status: 303, headers: { location: `./${query}` } });
const flash = (key: "error" | "connected" | "test", text: string): string =>
  `?${key}=${encodeURIComponent(text)}`;

const USAGE = `// in the project's code (itx is the project's root)
import { chatgptText, chatgptResponses } from "iterate-chatgpt";

await chatgptText(itx, { model: "gpt-5.5", input: "Say hello." });
// or the Responses API itself, streamed: the body you would send to api.openai.com
const response = await chatgptResponses(itx, { model: "gpt-5.5", input: [/* … */] });`;

async function card(itx: ChatgptItx): Promise<string> {
  if (await isConnected(itx)) {
    const account = await readAccount(itx);
    const models = await chatgptModels(itx).catch(() => null);
    return `<section>
      <h2>Connected <span class="muted">${esc(account?.email ?? "")}${account?.plan ? ` · ${esc(account.plan)}` : ""}</span></h2>
      <p>This project can make model requests with that ChatGPT subscription. The tokens are the secret <code>${SECRET}</code>, only ever sent to chatgpt.com and OpenAI's sign-in, and refreshed on their own.</p>
      ${models ? `<p class="muted">Models it can use: ${models.map((m) => `<code>${esc(m)}</code>`).join(", ")}</p>` : `<p class="warn">ChatGPT did not list the models. Try <b>Test it</b>.</p>`}
      <p>${post("test", "Test it")} ${post("disconnect", "Disconnect", true)}</p>
    </section>
    <section><h2>Use it</h2><pre>${esc(USAGE)}</pre>
    <p class="muted">Requests count against the plan's Codex limits, as if made in Codex.</p></section>`;
  }
  const pending = await readPending(itx);
  if (pending)
    return `<section>
      <h2>Finish signing in</h2>
      <ol>
        <li>Open <a href="${VERIFICATION_URL}" target="_blank" rel="noopener">${VERIFICATION_URL}</a> and sign in to ChatGPT.</li>
        <li>Type this code:</li>
      </ol>
      <p class="code">${esc(pending.userCode)}</p>
      <p class="muted">It works for 15 minutes. <span id="status">Waiting for you…</span> This page carries on by itself.</p>
      <p>${post("poll", "Check now", true)} ${post("cancel", "Cancel", true)}</p>
    </section>`;
  return `<section>
    <h2>Connect ChatGPT</h2>
    <p>Sign in with the ChatGPT account whose subscription should pay for this project's model requests. You sign in at OpenAI: this project never sees your password.</p>
    <p>${post("start", "Connect ChatGPT")}</p>
    <p class="muted">It uses the same sign-in as the Codex CLI. If OpenAI says device code sign-in is off, turn on <b>device code authorization for Codex</b> in ChatGPT's Settings, Security (a workspace admin may have to).</p>
  </section>`;
}

/** The members-only page: connect ChatGPT, see who is connected, test it, disconnect. Every write
 *  is a plain form POST answered with a redirect back to the page. */
export async function servePage(request: Request, withItx: WithItx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/_\/?/, "");

  if (request.method === "GET" && url.pathname === "/_")
    return new Response(null, { status: 308, headers: { location: "_/" } });
  if (request.method === "GET" && url.pathname === "/")
    return new Response(null, { status: 308, headers: { location: "_/" } });

  if (request.method === "GET" && path === "") {
    const error = url.searchParams.get("error");
    const tested = url.searchParams.get("test");
    const { body, pending } = await withItx(async (itx) => ({
      body: await card(itx),
      pending: await readPending(itx),
    }));
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const script = pending && !(await withItx((itx) => isConnected(itx)));
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>ChatGPT</title><style>${STYLE}</style></head><body><h1>ChatGPT</h1>${
        error ? `<p class="error">${esc(error)}</p>` : ""
      }${tested ? `<p class="ok">ChatGPT answered: ${esc(tested)}</p>` : ""}${body}${
        script && pending
          ? `<script nonce="${nonce}">${POLL_SCRIPT(pending.interval)}</script>`
          : ""
      }</body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'`,
        },
      },
    );
  }
  if (request.method !== "POST") return new Response("Not found\n", { status: 404 });

  try {
    if (path === "start") {
      await withItx((itx) => startLogin(itx));
      return redirect();
    }
    if (path === "poll") {
      // the page's script wants JSON; the "Check now" button, which sends a form, wants a page
      const wantsJson = request.headers.get("accept")?.includes("application/json") ?? false;
      const answer = await withItx((itx) => pollLogin(itx)).catch((error: unknown) => ({
        status: "error" as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (wantsJson) return Response.json(answer);
      return "error" in answer ? redirect(flash("error", answer.error)) : redirect();
    }
    if (path === "cancel" || path === "disconnect") {
      await withItx((itx) => disconnect(itx));
      return redirect();
    }
    if (path === "test") {
      const text = await withItx(async (itx) => {
        const model = (await chatgptModels(itx).catch(() => []))[0] ?? "gpt-5.5";
        return `${model}: ${(await chatgptText(itx, { model, input: "Reply with the single word: ready", effort: "low" })).trim()}`;
      });
      return redirect(flash("test", text));
    }
    return new Response("Not found\n", { status: 404 });
  } catch (error) {
    return redirect(flash("error", error instanceof Error ? error.message : String(error)));
  }
}

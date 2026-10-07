import {
  disconnect,
  finishLogin,
  isConnected,
  readAccount,
  readPending,
  REDIRECT_URI,
  SECRET,
  startLogin,
  type ChatgptItx,
} from "./auth.js";
import { register } from "./registry.js";
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
  textarea { font: .85rem ui-monospace, monospace; width: 100%; box-sizing: border-box; min-height: 5rem; }
  .error { background: #c0392b22; border: 1px solid #c0392b; border-radius: 8px; padding: .5rem .75rem; }
  .ok { background: #27ae6022; border: 1px solid #27ae60; border-radius: 8px; padding: .5rem .75rem; }
  .warn { background: #e67e2222; border: 1px solid #e67e22; border-radius: 8px; padding: .5rem .75rem; }
  .muted { opacity: .7; font-size: .9rem; } code, pre { word-break: break-all; white-space: pre-wrap; }
  form { display: inline; }
`;

const post = (action: string, label: string, quiet = false): string =>
  `<form method="post" action="${action}"><button${quiet ? ' class="quiet"' : ""}>${label}</button></form>`;

const redirect = (query = ""): Response =>
  new Response(null, { status: 303, headers: { location: `./${query}` } });
const flash = (key: "error" | "test", text: string): string =>
  `?${key}=${encodeURIComponent(text)}`;

const USAGE = `// in the project's code (itx is the project's root)
import { chatgptText, chatgptResponses } from "iterate-chatgpt";

await chatgptText(itx, { model: "gpt-5.5", input: "Say hello." });
// or the Responses API itself, streamed: the body you would send to api.openai.com
const response = await chatgptResponses(itx, { model: "gpt-5.5", input: [/* … */] });`;

/** The model the Test button tries: the first the token can see that is a GPT, else a guess. */
const testModelOf = (models: string[] | null): string =>
  models?.find((model) => model === "gpt-5.5") ??
  models?.find((m) => m.startsWith("gpt-")) ??
  "gpt-5.5";

async function card(itx: ChatgptItx): Promise<string> {
  if (await isConnected(itx)) {
    const account = await readAccount(itx);
    const models = await chatgptModels(itx).catch(() => null);
    return `<section>
      <h2>Connected <span class="muted">${esc(account?.email ?? "")}${account?.plan ? ` · ${esc(account.plan)}` : ""}</span></h2>
      <p>This project can make model requests with that ChatGPT plan. The tokens are the secret <code>${SECRET}</code>, only ever sent to api.openai.com and OpenAI's sign-in, and refreshed on their own.</p>
      ${models ? `<p class="muted">Models the token can see: ${models.map((m) => `<code>${esc(m)}</code>`).join(", ")}</p>` : `<p class="warn">OpenAI did not list the models. Try <b>Test it</b>.</p>`}
      <p>${post("test", "Test it")} ${post("disconnect", "Disconnect", true)}</p>
    </section>
    <section><h2>Use it</h2><pre>${esc(USAGE)}</pre>
    <p class="muted">Requests count against the plan's usage. Only the Responses API takes this token: voice, Realtime and transcription do not.</p></section>`;
  }
  const pending = await readPending(itx);
  if (pending)
    return `<section>
      <h2>Finish signing in</h2>
      <ol>
        <li><a class="button" href="${esc(pending.url)}" target="_blank" rel="noopener">Open ChatGPT sign-in</a></li>
        <li>Allow the app. The browser then tries to open <code>${esc(REDIRECT_URI)}</code> and shows an error. That is expected.</li>
        <li>Copy the whole address from the address bar and paste it here:</li>
      </ol>
      <form method="post" action="finish">
        <p><textarea name="callback" required spellcheck="false" placeholder="${esc(REDIRECT_URI)}?code=…"></textarea></p>
        <p><button>Connect</button></p>
      </form>
      <p class="muted">It works for 15 minutes, and the address works once. ${post("cancel", "Cancel", true)}</p>
    </section>`;
  return `<section>
    <h2>Connect ChatGPT</h2>
    <p>Sign in with the ChatGPT account whose plan should pay for this project's model requests. You sign in at OpenAI: this project never sees your password.</p>
    <p>${post("start", "Connect ChatGPT")}</p>
    <p class="muted">It uses OpenAI's Sign in with ChatGPT. OpenAI offers the plan's usage for Plus and Pro personal accounts, in a preview. A Team or Business workspace may be refused.</p>
  </section>`;
}

/** The members-only page: connect ChatGPT, see who is connected, test it, disconnect. Every write
 *  is a plain form POST answered with a redirect back to the page. Connecting and disconnecting
 *  register the connection on the Dash again; `slug` is the routing slug its buttons lead to. */
export async function servePage(
  request: Request,
  itx: ChatgptItx,
  slug: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\//, "");

  if (request.method === "GET" && path === "") {
    const error = url.searchParams.get("error");
    const tested = url.searchParams.get("test");
    const body = await card(itx);
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>ChatGPT</title><style>${STYLE}</style></head><body><h1>ChatGPT</h1>${
        error ? `<p class="error">${esc(error)}</p>` : ""
      }${tested ? `<p class="ok">OpenAI answered: ${esc(tested)}</p>` : ""}${body}</body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'`,
        },
      },
    );
  }
  if (request.method !== "POST") return new Response("Not found\n", { status: 404 });

  try {
    if (path === "start") {
      await startLogin(itx);
      return redirect();
    }
    if (path === "finish") {
      const pasted = (await request.formData()).get("callback");
      await finishLogin(itx, typeof pasted === "string" ? pasted : "");
      await register(itx, slug);
      return redirect();
    }
    if (path === "cancel") {
      await disconnect(itx);
      return redirect();
    }
    if (path === "disconnect") {
      await disconnect(itx);
      await register(itx, slug);
      return redirect();
    }
    if (path === "test") {
      const model = testModelOf(await chatgptModels(itx).catch(() => null));
      const answer = await chatgptText(itx, {
        model,
        input: "Reply with the single word: ready",
        effort: "low",
      });
      return redirect(flash("test", `${model}: ${answer.trim()}`));
    }
    return new Response("Not found\n", { status: 404 });
  } catch (error) {
    return redirect(flash("error", error instanceof Error ? error.message : String(error)));
  }
}

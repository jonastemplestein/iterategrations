import {
  disconnect,
  finishLogin,
  isConnected,
  readAccount,
  readPending,
  REDIRECT_URI,
  RESOURCE,
  SECRET,
  startLogin,
  type ChatgptItx,
} from "./auth.js";
import { register } from "./registry.js";

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
  .muted { opacity: .7; font-size: .9rem; } code, pre { word-break: break-all; white-space: pre-wrap; }
  form { display: inline; }
`;

const post = (action: string, label: string, quiet = false): string =>
  `<form method="post" action="${action}"><button${quiet ? ' class="quiet"' : ""}>${label}</button></form>`;

/** A form's answer: back to the page, which no other site may frame either. */
const redirect = (query = ""): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: `./${query}`,
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    },
  });
const flash = (key: "error" | "test", text: string): string =>
  `?${key}=${encodeURIComponent(text)}`;

/** The model the Test button asks: the first one OpenAI lists for a plan's token. */
const TEST_MODEL = "gpt-6.1-sol";
const AUTHORIZATION = `Bearer getSecret("${SECRET}", { field: "accessToken" })`;
const README = "https://github.com/jonastemplestein/iterategrations/tree/main/chatgpt";

const USAGE = `// project code, a run script, an agent: the global fetch is the project's egress
const response = await fetch("${RESOURCE}/responses", {
  method: "POST",
  headers: {
    authorization: '${AUTHORIZATION}',
    "content-type": "application/json",
  },
  // a plan's token answers only a stream, keeps nothing, and takes input as a list
  body: JSON.stringify({
    model: "${TEST_MODEL}",
    input: [{ role: "user", content: "Say hello." }],
    stream: true,
    store: false,
  }),
});`;

/** The Test button's one request: the model's one-word answer, read from the server-sent events
 *  as the README's example reads them. Throws what OpenAI says when it refuses. */
async function testAnswer(itx: Pick<ChatgptItx, "fetch">): Promise<string> {
  const response = await itx.fetch(
    new Request(`${RESOURCE}/responses`, {
      method: "POST",
      headers: { authorization: AUTHORIZATION, "content-type": "application/json" },
      body: JSON.stringify({
        model: TEST_MODEL,
        input: [{ role: "user", content: "Reply with the single word: ready" }],
        reasoning: { effort: "low" },
        stream: true,
        store: false,
      }),
    }),
  );
  const stream = await response.text();
  if (!response.ok) throw new Error(`OpenAI answered ${response.status}: ${stream.slice(0, 400)}`);
  let answer = "";
  for (const block of stream.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "") continue;
    const event = JSON.parse(data);
    if (event.type === "response.output_text.delta") answer += event.delta;
    if (event.type === "response.completed") return answer;
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "response.failed" || event.type === "response.incomplete")
      throw new Error(JSON.stringify(event.response.error ?? event.response.incomplete_details));
  }
  throw new Error("OpenAI's answer ended before response.completed");
}

async function card(itx: ChatgptItx): Promise<string> {
  if (await isConnected(itx)) {
    const account = await readAccount(itx);
    return `<section>
      <h2>Connected <span class="muted">${esc(account?.email ?? "")}${account?.plan ? ` · ${esc(account.plan)}` : ""}</span></h2>
      <p>This project can make model requests with that ChatGPT plan. The tokens are the secret <code>${SECRET}</code>, only ever sent to api.openai.com and OpenAI's sign-in, and refreshed on their own.</p>
      <p>${post("test", "Test it")} ${post("disconnect", "Disconnect", true)}</p>
    </section>
    <section><h2>Use it</h2>
    <p>Project code and agents call the Responses API with plain <code>fetch</code> and a placeholder for the token. The project's egress puts the real token in.</p>
    <pre>${esc(USAGE)}</pre>
    <p class="muted">The answer is server-sent events. <a href="${README}#calling-the-responses-api" target="_blank" rel="noopener">The README</a> reads them into text, and lists the fields a plan's token refuses. Requests count against the plan's usage. Only the Responses API takes this token: voice, Realtime and transcription do not.</p></section>`;
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
          // no other site may frame it: a framed form would post from this origin and pass the
          // member gate (default-src does not cover frame-ancestors)
          "x-frame-options": "DENY",
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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
      const answer = await testAnswer(itx);
      return redirect(flash("test", `${TEST_MODEL}: ${answer.trim()}`));
    }
    return new Response("Not found\n", { status: 404 });
  } catch (error) {
    return redirect(flash("error", error instanceof Error ? error.message : String(error)));
  }
}

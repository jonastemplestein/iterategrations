// Runs against dist, the package as shipped. `fakeProject` is a project: a kv, secrets, and an egress
// to a pretend OpenAI (its device sign-in and token endpoint) and a pretend ChatGPT backend, which
// record every request.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  chatgptBody,
  chatgptHeaders,
  chatgptModels,
  chatgptRequest,
  chatgptText,
  EXCHANGE_SOURCE,
  serveChatgpt,
} from "../dist/chatgpt.js";

const b64 = (value: unknown): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: unknown): string => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const ID_TOKEN = jwt({
  email: "jonas@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
});

type Call = { url: string; method: string; headers: Headers; body: string };

function fakeProject(options: { deviceOpen?: boolean; chatgptStatus?: number } = {}) {
  const secrets: Record<string, { material: any; options: any }> = {};
  const kv: Record<string, string> = {};
  const calls: Call[] = [];
  let typed = false; // the person typed the code at OpenAI
  const itx: any = {
    secrets: {
      set: async (path: string, material: unknown, options: unknown) =>
        void (secrets[path] = { material, options }),
      delete: async (path: string) => void delete secrets[path],
      list: async () => Object.keys(secrets).map((path) => ({ path })),
    },
    kv: {
      get: async (key: string) => kv[key] ?? null,
      put: async (key: string, value: string) => void (kv[key] = value),
      delete: async (key: string) => void delete kv[key],
    },
    fetch: async (request: Request) => {
      const call = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      };
      calls.push(call);
      const { pathname, origin } = new URL(request.url);
      if (origin === "https://auth.openai.com") {
        if (pathname === "/api/accounts/deviceauth/usercode")
          return options.deviceOpen === false
            ? new Response("no", { status: 404 })
            : Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" });
        if (pathname === "/api/accounts/deviceauth/token")
          return typed
            ? Response.json({ authorization_code: "auth-code", code_verifier: "verifier" })
            : new Response("pending", { status: 403 });
        if (pathname === "/oauth/token")
          return Response.json({
            id_token: ID_TOKEN,
            access_token: "access-1",
            refresh_token: "refresh-1",
          });
      }
      if (origin === "https://chatgpt.com") {
        if (options.chatgptStatus) return new Response("nope", { status: options.chatgptStatus });
        if (pathname.endsWith("/models"))
          return Response.json({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4" }] });
        return new Response(
          [
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "re" })}\n\n`,
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ady" })}\r\n\r\n`,
            `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    },
  };
  const withItx = async (call: (itx: any) => unknown) => call(itx);
  const page = async (path: string, method = "GET", headers: Record<string, string> = {}) => {
    const res = await serveChatgpt(
      new Request(`https://chatgpt--jeeves.example${path}`, {
        method,
        headers: { "x-iterate-routing-slug": "chatgpt", ...headers },
      }),
      { withItx: withItx as any, requireMember: () => null },
    );
    assert.ok(res, "a request on the chatgpt slug is answered");
    return res;
  };
  return {
    itx,
    secrets,
    kv,
    calls,
    page,
    typeCode: () => void (typed = true),
  };
}

test("another slug is not ours, and a non-member is refused", async () => {
  const project = fakeProject();
  const other = await serveChatgpt(
    new Request("https://x.example/_/", { headers: { "x-iterate-routing-slug": "telegram" } }),
    { withItx: (async (c: any) => c(project.itx)) as any, requireMember: () => null },
  );
  assert.equal(other, null);
  const refused = await serveChatgpt(
    new Request("https://x.example/_/", { headers: { "x-iterate-routing-slug": "chatgpt" } }),
    {
      withItx: (async (c: any) => c(project.itx)) as any,
      requireMember: () => new Response("sign in", { status: 401 }),
    },
  );
  assert.equal(refused?.status, 401);
  assert.deepEqual(project.calls, []);
});

test("the page offers Connect, then shows the code, then the account", async () => {
  const project = fakeProject();
  let res = await project.page("/_/");
  let html = await res.text();
  assert.match(html, /Connect ChatGPT/);
  assert.match(res.headers.get("content-security-policy")!, /script-src 'nonce-/);

  res = await project.page("/_/start", "POST");
  assert.equal(res.status, 303);
  html = await (await project.page("/_/")).text();
  assert.match(html, /ABCD-1234/);
  assert.match(html, /auth\.openai\.com\/codex\/device/);
  assert.match(html, /<script nonce=/, "the page polls by itself");

  // not typed yet: waiting, nothing stored
  let answer: any = await (
    await project.page("/_/poll", "POST", { accept: "application/json" })
  ).json();
  assert.deepEqual(answer, { status: "waiting" });
  assert.deepEqual(project.secrets, {});

  project.typeCode();
  answer = await (await project.page("/_/poll", "POST", { accept: "application/json" })).json();
  assert.equal(answer.status, "connected");
  assert.equal(answer.account.email, "jonas@example.com");

  const secret = project.secrets["/secrets/chatgpt"]!;
  assert.deepEqual(secret.material, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accountId: "acct-1",
  });
  assert.deepEqual(secret.options.urls, ["https://chatgpt.com", "https://auth.openai.com"]);
  assert.equal(secret.options.refresh.kind, "worker");
  assert.equal(secret.options.refresh.source, EXCHANGE_SOURCE);
  assert.equal(project.kv["chatgpt/pending"], undefined, "the device code is spent");

  // the code exchange sent the verifier OpenAI issued, with the device redirect
  const exchange = project.calls.find((c) => c.url === "https://auth.openai.com/oauth/token")!;
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "auth-code");
  assert.equal(form.get("code_verifier"), "verifier");
  assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
  assert.equal(form.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");

  html = await (await project.page("/_/")).text();
  assert.match(html, /jonas@example\.com/);
  assert.match(html, /pro/);
  assert.match(html, /gpt-5\.5/);
  assert.doesNotMatch(html, /access-1|refresh-1/, "no token is ever shown");
});

test("a refused sign-in is shown on the page", async () => {
  const project = fakeProject({ deviceOpen: false });
  const res = await project.page("/_/start", "POST");
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get("location")!), /device code authorization/);
  const html = await (await project.page(res.headers.get("location")!.replace("./", "/_/"))).text();
  assert.match(html, /class="error"/);
});

test("test it asks ChatGPT, and disconnect forgets everything", async () => {
  const project = fakeProject();
  await project.page("/_/start", "POST");
  project.typeCode();
  await project.page("/_/poll", "POST", { accept: "application/json" });

  const tested = await project.page("/_/test", "POST");
  assert.match(decodeURIComponent(tested.headers.get("location")!), /gpt-5\.5: ready/);
  const sent = project.calls.find((c) => c.url.endsWith("/codex/responses"))!;
  assert.equal(sent.method, "POST");

  await project.page("/_/disconnect", "POST");
  assert.deepEqual(project.secrets, {});
  assert.equal(project.kv["chatgpt/account"], undefined);
  assert.match(await (await project.page("/_/")).text(), /Connect ChatGPT/);
});

test("a model request carries placeholders for both tokens, and a body ChatGPT takes", async () => {
  const headers = chatgptHeaders("session-1");
  assert.equal(
    headers.authorization,
    'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })',
  );
  assert.equal(
    headers["chatgpt-account-id"],
    'getSecret("/secrets/chatgpt", { field: "accountId" })',
  );
  assert.equal(headers.session_id, "session-1");

  assert.deepEqual(
    chatgptBody({
      model: "m",
      input: [],
      max_output_tokens: 5,
      temperature: 1,
      store: true,
      stream: false,
    }),
    { instructions: "", model: "m", input: [], stream: true, store: false },
  );
  assert.equal(
    chatgptBody({ model: "m", instructions: "be brief" }).instructions,
    "be brief",
    "the caller's instructions win",
  );

  const request = chatgptRequest({ model: "gpt-5.5", input: [] });
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.method, "POST");
});

test("chatgptText reads the stream, models lists slugs, and a failure says what ChatGPT said", async () => {
  const project = fakeProject();
  assert.equal(await chatgptText(project.itx, { model: "gpt-5.5", input: "hi" }), "ready");
  const body = JSON.parse(project.calls.at(-1)!.body);
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
  assert.deepEqual(await chatgptModels(project.itx), ["gpt-5.5", "gpt-5.4"]);

  const broken = fakeProject({ chatgptStatus: 429 });
  await assert.rejects(
    chatgptText(broken.itx, { model: "gpt-5.5", input: "hi" }),
    /chatgpt\/gpt-5\.5 429: nope/,
  );
});

// The exchange code, run as the platform runs it: an ES module whose `exchange(material, fetch)`
// returns the next material.
async function runExchange(material: any, fetch: (url: string, init: any) => Promise<Response>) {
  const url = `data:text/javascript;base64,${Buffer.from(EXCHANGE_SOURCE).toString("base64")}`;
  const { exchange } = await import(url);
  return exchange(material, fetch);
}

test("the exchange code trades the refresh token and keeps the rotated one", async () => {
  const seen: any[] = [];
  const next = await runExchange(
    { accessToken: "old", refreshToken: "r-old", accountId: "acct-1" },
    async (url, init) => {
      seen.push({ url, form: new URLSearchParams(init.body) });
      return Response.json({
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-2" } }),
        access_token: "new",
        refresh_token: "r-new",
      });
    },
  );
  assert.equal(seen[0].url, "https://auth.openai.com/oauth/token");
  assert.equal(seen[0].form.get("grant_type"), "refresh_token");
  assert.equal(seen[0].form.get("refresh_token"), "r-old");
  assert.deepEqual(next, { accessToken: "new", refreshToken: "r-new", accountId: "acct-2" });

  // an answer with no new refresh token or id token keeps what the secret had
  const kept = await runExchange(
    { accessToken: "old", refreshToken: "r-old", accountId: "acct-1" },
    async () => Response.json({ access_token: "newer" }),
  );
  assert.deepEqual(kept, { accessToken: "newer", refreshToken: "r-old", accountId: "acct-1" });
});

test("a refused refresh says to sign in again, naming OpenAI's code but never a token", async () => {
  await assert.rejects(
    runExchange({ refreshToken: "r-secret" }, async () =>
      Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 }),
    ),
    (error: Error) =>
      /401 refresh_token_reused/.test(error.message) &&
      /sign in again/.test(error.message) &&
      !error.message.includes("r-secret"),
  );
  await assert.rejects(
    runExchange({}, async () => new Response("")),
    /no refresh token/,
  );
});

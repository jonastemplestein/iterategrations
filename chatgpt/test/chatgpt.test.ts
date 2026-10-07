// Runs against dist, the package as shipped. `fakeProject` is a project: a kv, secrets, appends
// that refuse a key used twice for another event (as the platform does; the same event again is a
// no-op), and an egress to a pretend OpenAI (its token endpoint and its API), which record every
// request. `host` is the worker hosting the package: a scope per `getItx`, counted.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  chatgpt,
  chatgptBody,
  chatgptHeaders,
  chatgptModels,
  chatgptRequest,
  chatgptText,
  EXCHANGE_SOURCE,
} from "../dist/chatgpt.js";

const b64 = (value: unknown): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: unknown): string => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const ID_TOKEN = jwt({
  sub: "user-1",
  email: "jonas@example.com",
  "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
});
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

type Call = { url: string; method: string; headers: Headers; body: string };

function fakeProject(options: { scope?: string; apiStatus?: number; slug?: string } = {}) {
  const secrets: Record<string, { material: any; options: any }> = {};
  const kv: Record<string, string> = {};
  const calls: Call[] = [];
  const appended: { path: string; event: any }[] = [];
  const scopes = { opened: 0, disposed: 0 };
  const faults = { deletes: false };
  const itx: any = {
    cd: (path: string) => ({
      append: async (event: any) => {
        const earlier = appended.find(
          (a) =>
            a.path === path &&
            event.idempotencyKey !== undefined &&
            a.event.idempotencyKey === event.idempotencyKey,
        );
        if (earlier && JSON.stringify(earlier.event) === JSON.stringify(event)) return;
        if (earlier) throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
    secrets: {
      set: async (path: string, material: unknown, options: unknown) =>
        void (secrets[path] = { material, options }),
      delete: async (path: string) => {
        if (faults.deletes)
          throw Object.assign(new Error("the secret store is unavailable"), {
            code: "UNAVAILABLE",
          });
        if (!secrets[path])
          throw Object.assign(new Error(`secret ${path}: never set`), { code: "SECRET_NOT_SET" });
        delete secrets[path];
      },
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
      if (origin === "https://auth.openai.com" && pathname === "/api/accounts/oauth/token")
        return Response.json({
          id_token: ID_TOKEN,
          access_token: "access-1",
          refresh_token: "refresh-1",
          scope: options.scope ?? SCOPE,
        });
      if (origin === "https://api.openai.com") {
        if (options.apiStatus) return new Response("nope", { status: options.apiStatus });
        if (pathname === "/v1/models")
          return Response.json({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }] });
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
  const integration = chatgpt(options.slug ? { slug: options.slug } : {});
  const page = async (
    path: string,
    init: RequestInit = {},
    requireMember: (request: Request) => Response | null = () => null,
  ) =>
    integration.fetch!(new Request(`https://chatgpt--jeeves.example${path}`, init), {
      getItx: () => {
        scopes.opened++;
        return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
      },
      auth: { require: requireMember },
    });
  const paste = (address: string) =>
    page("/finish", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ callback: address }).toString(),
    });
  /** The platform's `project/worker-updated` on `/`, at `offset`: the install hook. */
  const publish = (offset: number) =>
    integration.processEvent!({
      event: { type: "events.iterate.com/project/worker-updated", path: "/", offset },
      itx,
    });
  /** What was registered on `/integrations` for the Dash, in order. */
  const registry = () => appended.filter((a) => a.path === "/integrations").map((a) => a.event);
  return { integration, itx, secrets, kv, calls, scopes, faults, page, paste, publish, registry };
}

/** The address OpenAI's consent ends on, for the sign-in the page opened. */
function callbackFor(html: string, extra: Record<string, string> = {}): string {
  const href = /href="([^"]*authorize[^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&");
  const state = new URL(href).searchParams.get("state")!;
  const query = new URLSearchParams({
    code: "auth-code",
    state,
    client_id: "oaiapp_issued",
    ...extra,
  });
  return `http://127.0.0.1:1455/auth/callback?${query.toString()}`;
}

test("it answers its own routing slug, chatgpt unless another is given; a non-member is refused and opens no scope", async () => {
  assert.equal(chatgpt().routingSlug, "chatgpt");
  assert.equal(chatgpt({ slug: "openai" }).routingSlug, "openai");
  const project = fakeProject();
  for (const [path, method] of [
    ["/", "GET"],
    ["/start", "POST"],
  ] as const) {
    const refused = await project.page(
      path,
      { method },
      () => new Response("sign in", { status: 401 }),
    );
    assert.equal(refused.status, 401);
  }
  assert.deepEqual(project.calls, []);
  assert.deepEqual(project.kv, {});
  assert.equal(project.scopes.opened, 0);
  await project.page("/");
  assert.deepEqual(project.scopes, { opened: 1, disposed: 1 });
});

test("the page offers Connect, then the consent link and a paste box, then the account", async () => {
  const project = fakeProject();
  let res = await project.page("/");
  let html = await res.text();
  assert.match(html, /Connect ChatGPT/);
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
  // no other site can frame it
  assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");

  res = await project.page("/start", { method: "POST" });
  assert.equal(res.status, 303);
  html = await (await project.page("/")).text();
  assert.match(html, /Open ChatGPT sign-in/);
  assert.match(html, /name="callback"/);

  const consent = new URL(/href="([^"]*authorize[^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&"));
  assert.equal(consent.origin + consent.pathname, "https://auth.openai.com/api/accounts/authorize");
  const query = consent.searchParams;
  assert.equal(query.get("client_id"), "dynamic_agent_client");
  assert.equal(query.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(query.get("resource"), "https://api.openai.com/v1");
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.match(query.get("ext_agent_host_id")!, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.ok(query.get("scope")!.split(" ").includes("chatgpt.tokens.use.direct"));
  assert.deepEqual(project.secrets, {});
  assert.deepEqual(project.calls, [], "nothing is sent to OpenAI before the person pastes");

  res = await project.paste(callbackFor(html));
  assert.equal(res.status, 303);
  assert.doesNotMatch(res.headers.get("location")!, /error/);

  const secret = project.secrets["/secrets/chatgpt"]!;
  assert.deepEqual(secret.material, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    clientId: "oaiapp_issued",
  });
  assert.deepEqual(secret.options.urls, ["https://api.openai.com", "https://auth.openai.com"]);
  assert.equal(secret.options.refresh.kind, "worker");
  assert.equal(secret.options.refresh.source, EXCHANGE_SOURCE);
  assert.equal(project.kv["chatgpt/pending"], undefined, "the sign-in is spent");

  // the exchange names OpenAI's issued client, the verifier kept here, and the resource
  const exchange = (project.calls as Call[]).find((c) => c.url.endsWith("/oauth/token"))!;
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_id"), "oaiapp_issued");
  assert.equal(form.get("code"), "auth-code");
  assert.equal(form.get("resource"), "https://api.openai.com/v1");
  assert.equal(form.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.ok(form.get("code_verifier")!.length >= 43);

  html = await (await project.page("/")).text();
  assert.match(html, /jonas@example\.com/);
  assert.match(html, /pro/);
  assert.match(html, /gpt-5\.5/);
  assert.doesNotMatch(html, /access-1|refresh-1/, "no token is ever shown");
});

test("a bad paste is shown on the page, and the sign-in survives it", async () => {
  const project = fakeProject();
  await project.page("/start", { method: "POST" });
  const html = await (await project.page("/")).text();
  const good = callbackFor(html);

  for (const [bad, message] of [
    ["not an address", /whole address/],
    ["http://127.0.0.1:9/other?code=x", /must start with/],
    [good.replace(/state=[^&]*/, "state=other"), /another sign-in/],
    [callbackFor(html, { error: "access_denied" }), /did not connect: access_denied/],
  ] as const) {
    const res = await project.paste(bad);
    assert.match(decodeURIComponent(res.headers.get("location")!), message);
  }
  assert.deepEqual(project.calls, []);
  assert.ok(project.kv["chatgpt/pending"], "still waiting for a good address");

  const shown = await (
    await project.page((await project.paste("nope")).headers.get("location")!.replace("./", "/"))
  ).text();
  assert.match(shown, /class="error"/);
});

test("a sign-in without the plan's scope is refused and keeps no secret", async () => {
  const project = fakeProject({ scope: "openid profile email" });
  await project.page("/start", { method: "POST" });
  const res = await project.paste(callbackFor(await (await project.page("/")).text()));
  assert.match(decodeURIComponent(res.headers.get("location")!), /Plus or Pro/);
  assert.deepEqual(project.secrets, {});
  assert.equal(project.kv["chatgpt/pending"], undefined, "the code is spent either way");
});

test("test it asks OpenAI, and disconnect forgets everything", async () => {
  const project = fakeProject();
  await project.page("/start", { method: "POST" });
  await project.paste(callbackFor(await (await project.page("/")).text()));

  const tested = await project.page("/test", { method: "POST" });
  assert.match(decodeURIComponent(tested.headers.get("location")!), /gpt-5\.5: ready/);
  const sent = (project.calls as Call[]).find(
    (c) => c.url === "https://api.openai.com/v1/responses",
  )!;
  assert.equal(sent.method, "POST");

  await project.page("/disconnect", { method: "POST" });
  assert.deepEqual(project.secrets, {});
  assert.equal(project.kv["chatgpt/account"], undefined);
  assert.match(await (await project.page("/")).text(), /Connect ChatGPT/);
  assert.equal((await project.page("/anything-else", { method: "POST" })).status, 404);
});

test("a model request carries a placeholder for the token, and a body the plan takes", async () => {
  assert.deepEqual(chatgptHeaders(), {
    authorization: 'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })',
    "content-type": "application/json",
    accept: "text/event-stream",
  });

  assert.deepEqual(
    chatgptBody({
      model: "m",
      input: [],
      max_output_tokens: 5,
      temperature: 1,
      top_p: 1,
      user: "u",
      previous_response_id: "r",
      store: true,
      stream: false,
      tools: [{ type: "function" }],
    }),
    { model: "m", input: [], stream: true, store: false, tools: [{ type: "function" }] },
  );
  assert.deepEqual(chatgptBody({ model: "m", input: "hi" }).input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);

  const request = chatgptRequest({ model: "gpt-5.5", input: [] });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.method, "POST");
});

test("chatgptText reads the stream, models lists ids, and a failure says what OpenAI said", async () => {
  const project = fakeProject();
  assert.equal(await chatgptText(project.itx, { model: "gpt-5.5", input: "hi" }), "ready");
  const body = JSON.parse(project.calls.at(-1)!.body);
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
  assert.deepEqual(await chatgptModels(project.itx), ["gpt-5.5", "gpt-5.4"]);
  // a plan's token gets Codex's shape, and hidden models stay unlisted
  const codexShaped: any = {
    fetch: async () =>
      Response.json({
        models: [
          { slug: "gpt-6.1-sol", visibility: "list" },
          { slug: "gpt-reserve", visibility: "hide" },
        ],
      }),
  };
  assert.deepEqual(await chatgptModels(codexShaped), ["gpt-6.1-sol"]);

  const broken = fakeProject({ apiStatus: 429 });
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

test("the exchange code trades the refresh token with OpenAI's client and keeps the rotated one", async () => {
  const seen: any[] = [];
  const next = await runExchange(
    { accessToken: "old", refreshToken: "r-old", clientId: "oaiapp_issued" },
    async (url, init) => {
      seen.push({ url, form: new URLSearchParams(init.body) });
      return Response.json({ access_token: "new", refresh_token: "r-new" });
    },
  );
  assert.equal(seen[0].url, "https://auth.openai.com/api/accounts/oauth/token");
  assert.equal(seen[0].form.get("grant_type"), "refresh_token");
  assert.equal(seen[0].form.get("client_id"), "oaiapp_issued");
  assert.equal(seen[0].form.get("refresh_token"), "r-old");
  assert.equal(seen[0].form.get("resource"), "https://api.openai.com/v1");
  assert.deepEqual(next, { accessToken: "new", refreshToken: "r-new", clientId: "oaiapp_issued" });

  // an answer with no new refresh token keeps the one the secret had
  const kept = await runExchange(
    { accessToken: "old", refreshToken: "r-old", clientId: "oaiapp_issued" },
    async () => Response.json({ access_token: "newer" }),
  );
  assert.deepEqual(kept, {
    accessToken: "newer",
    refreshToken: "r-old",
    clientId: "oaiapp_issued",
  });
});

test("a refused refresh says to connect again, naming OpenAI's code but never a token", async () => {
  await assert.rejects(
    runExchange({ refreshToken: "r-secret", clientId: "oaiapp_issued" }, async () =>
      Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 }),
    ),
    (error: Error) =>
      /401 refresh_token_reused/.test(error.message) &&
      /connect ChatGPT again/.test(error.message) &&
      !error.message.includes("r-secret"),
  );
  await assert.rejects(
    runExchange({}, async () => new Response("")),
    /no refresh token/,
  );
});

// --------------------------------------------- the Dash's Integrations page

const card = (status: object, label: string, routingSlug = "chatgpt") => ({
  title: "ChatGPT",
  description:
    "Bring your own ChatGPT: Responses API requests paid by a ChatGPT Plus or Pro plan, not an API key.",
  status,
  actions: [{ label, routingSlug, path: "/" }],
});
const row = (routingSlug = "chatgpt") => ({
  account: "jonas@example.com",
  status: { kind: "ok" },
  actions: [{ label: "Manage", routingSlug, path: "/" }],
  details: { Plan: "pro" },
});
const CONFIGURED = "events.iterate.com/integration/configured";
const CONNECTION_CONFIGURED = "events.iterate.com/integration/connection-configured";

test("the install hook registers the card and the connection's row, or takes the row away, keyed by the event's path and offset", async () => {
  const project = fakeProject();
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "chatgpt:registry:/@5",
      payload: {
        integration: "chatgpt",
        card: card({ kind: "attention", text: "Connect ChatGPT" }, "Connect"),
      },
    },
    {
      type: CONNECTION_CONFIGURED,
      idempotencyKey: "chatgpt:registry:account:/@5",
      payload: { integration: "chatgpt", connection: "account", row: null },
    },
  ]);

  await project.page("/start", { method: "POST" });
  await project.paste(callbackFor(await (await project.page("/")).text()));
  const before = project.registry().length;
  await project.publish(5); // the same event again, now connected: its keys are spent
  assert.equal(project.registry().length, before);
  await project.publish(9);
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONFIGURED,
      idempotencyKey: "chatgpt:registry:/@9",
      payload: { integration: "chatgpt", card: card({ kind: "ok" }, "Manage") },
    },
    {
      type: CONNECTION_CONFIGURED,
      idempotencyKey: "chatgpt:registry:account:/@9",
      payload: { integration: "chatgpt", connection: "account", row: row() },
    },
  ]);
});

test("connecting registers the card and the account's row; disconnecting takes the row away; the buttons lead to the slug it answers on", async () => {
  const project = fakeProject({ slug: "openai" });
  await project.page("/start", { method: "POST" });
  assert.deepEqual(project.registry(), [], "starting a sign-in registers nothing");
  await project.paste(callbackFor(await (await project.page("/")).text()));
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      payload: { integration: "chatgpt", card: card({ kind: "ok" }, "Manage", "openai") },
    },
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "chatgpt", connection: "account", row: row("openai") },
    },
  ]);

  await project.page("/disconnect", { method: "POST" });
  assert.deepEqual(project.registry().slice(2), [
    {
      type: CONFIGURED,
      payload: {
        integration: "chatgpt",
        card: card({ kind: "attention", text: "Connect ChatGPT" }, "Connect", "openai"),
      },
    },
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "chatgpt", connection: "account", row: null },
    },
  ]);
  const count = project.registry().length;
  await project.integration.processEvent!({
    event: { type: "events.iterate.com/secret/set", path: "/secrets/chatgpt", offset: 3 },
    itx: project.itx,
  });
  assert.equal(project.registry().length, count, "the hook ignores every other event");
});

test("a Disconnect whose secret cannot be deleted says so, and ChatGPT stays connected for another try", async () => {
  const project = fakeProject();
  await project.page("/start", { method: "POST" });
  await project.paste(callbackFor(await (await project.page("/")).text()));
  const before = project.registry().length;
  project.faults.deletes = true;
  const failed = await project.page("/disconnect", { method: "POST" });
  assert.match(
    decodeURIComponent(failed.headers.get("location")!),
    /error=the secret store is unavailable/,
  );
  assert.ok(project.secrets["/secrets/chatgpt"], "the tokens stay, and say so");
  assert.ok(project.kv["chatgpt/account"]);
  assert.equal(project.registry().length, before, "no row is taken away");
  assert.match(await (await project.page("/")).text(), /jonas@example\.com/);
  project.faults.deletes = false;
  await project.page("/disconnect", { method: "POST" });
  assert.deepEqual(project.secrets, {});
  // and a sign-in cancelled before it held any secret is fine
  await project.page("/start", { method: "POST" });
  assert.equal((await project.page("/cancel", { method: "POST" })).headers.get("location"), "./");
});

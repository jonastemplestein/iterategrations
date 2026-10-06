// Runs against dist, the package as shipped. `fakeProject` is a project: secrets, streams with a kv
// each, agents, appends that refuse a key used twice (as the platform does), and an egress to a
// pretend Telegram that records every Bot API call.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { serveTelegram } from "../dist/telegram.js";

const BOT = "iterate-bot";
const STREAM = `/integrations/telegram/${BOT}`;
const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef";

type Call = { method: string; credential: string; body: any };

function fakeProject() {
  const secrets: Record<string, unknown> = {};
  const kv: Record<string, Record<string, string>> = {};
  const appended: { path: string; event: any }[] = [];
  const agents: string[] = [];
  const calls: Call[] = [];
  const store = (path: string) => (kv[path] ??= {});
  const itx: any = {
    secrets: {
      set: async (path: string, material: unknown, options: unknown) =>
        void (secrets[path] = { material, options }),
      delete: async (path: string) => void delete secrets[path],
      verifyEquals: async (path: string, { value }: { value: string }) =>
        (secrets[path] as any)?.material === value,
    },
    agents: { create: async (path: string) => void agents.push(path) },
    cd: (path: string) => ({
      kv: {
        get: async (key: string) => store(path)[key] ?? null,
        put: async (key: string, value: string) => void (store(path)[key] = value),
        delete: async (key: string) => void delete store(path)[key],
        list: async (prefix = "") => ({
          keys: Object.keys(store(path)).filter((key) => key.startsWith(prefix)),
        }),
      },
      append: async (event: any) => {
        if (
          appended.some((a) => a.path === path && a.event.idempotencyKey === event.idempotencyKey)
        )
          throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
    fetch: async (request: Request) => {
      const url = decodeURIComponent(request.url);
      const rest = url.slice("https://api.telegram.org/bot".length);
      const method = rest.slice(rest.lastIndexOf("/") + 1);
      const credential = rest.slice(0, rest.lastIndexOf("/"));
      calls.push({ method, credential, body: JSON.parse(await request.text()) });
      if (credential.includes("bad"))
        return Response.json({ ok: false, error_code: 401, description: "Unauthorized" });
      if (method === "getMe")
        return Response.json({ ok: true, result: { id: 1001, username: "Iterate_Bot" } });
      return Response.json({ ok: true, result: true });
    },
  };
  const withItx = async (call: (itx: any) => unknown) => call(itx);
  const serve = async (request: Request, requireMember: (r: Request) => Response | null) => {
    const res = await serveTelegram(request, { withItx: withItx as any, requireMember });
    assert.ok(res, "a request on the telegram slug is answered");
    return res;
  };
  const hook = async (path: string, body: unknown, token: string | null = "s3cret") =>
    serve(
      new Request(`https://telegram--iterate.example${path}`, {
        method: "POST",
        headers: {
          "x-iterate-routing-slug": "telegram",
          ...(token === null ? {} : { "x-telegram-bot-api-secret-token": token }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      () => null,
    );
  const connected = async (allowed: Record<string, object> = {}) => {
    secrets[`/secrets/telegram-webhook-${BOT}`] = { material: "s3cret" };
    store(STREAM).bot = JSON.stringify({ id: 1001, username: "Iterate_Bot" });
    store("/integrations/telegram")[`bots/${BOT}`] = "Iterate_Bot";
    for (const [id, person] of Object.entries(allowed))
      store(STREAM)[`allowed/${id}`] = JSON.stringify(person);
  };
  const page = async (
    path: string,
    init: { form?: Record<string, string>; headers?: Record<string, string> } = {},
    requireMember: (request: Request) => Response | null = () => null,
  ) =>
    serve(
      new Request(`https://telegram--iterate.example${path}`, {
        method: init.form ? "POST" : "GET",
        headers: {
          "x-iterate-routing-slug": "telegram",
          "x-iterate-base-path": "",
          ...init.headers,
        },
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
      requireMember,
    );
  return { secrets, kv: store, appended, agents, calls, hook, connected, page };
}

const message = (over: Record<string, unknown> = {}, from: Record<string, unknown> = {}) => ({
  message_id: 7,
  from: { id: 42, is_bot: false, first_name: "Jonas", username: "jonas", ...from },
  chat: { id: 42, type: "private" },
  text: "hello",
  ...over,
});
const group = (over: Record<string, unknown> = {}, from: Record<string, unknown> = {}) =>
  message({ chat: { id: -100, type: "supergroup", title: "Home" }, ...over }, from);
const sent = (project: ReturnType<typeof fakeProject>, method = "sendMessage") =>
  project.calls.filter((c) => c.method === method);
const agentEvents = (project: ReturnType<typeof fakeProject>) =>
  project.appended.filter((a) => a.path.startsWith("/agents/"));
const ME = { name: "Jonas", username: "jonas", at: "x" };
const WIFE = { name: "Wife", username: "wife", at: "x" };

// ---------------------------------------------------------------- partial fetch

test("it is a partial fetch: a request that is not on the telegram slug is null, touching nothing", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  const touched: string[] = [];
  const options = {
    withItx: (async () => void touched.push("itx")) as any,
    requireMember: () => void touched.push("auth") as never,
  };
  for (const headers of [
    {},
    { "x-iterate-routing-slug": "pebble" },
    { "x-iterate-routing-slug": "telegram-x" },
  ])
    for (const path of ["/_/", `/${BOT}`, "/"])
      assert.equal(
        await serveTelegram(
          new Request(`https://x.example${path}`, { method: "POST", headers }),
          options,
        ),
        null,
      );
  assert.deepEqual(touched, []);
  // and the slug can be another
  const other = await serveTelegram(
    new Request(`https://x.example/${BOT}`, { headers: { "x-iterate-routing-slug": "tg" } }),
    { ...options, slug: "tg" },
  );
  assert.equal(other!.status, 405);
});

// ---------------------------------------------------------------- webhook

test("an update is recorded on the bot's stream keyed by update_id, the update untouched", async () => {
  const project = fakeProject();
  await project.connected();
  const update = { update_id: 900, message: message() };
  assert.equal((await project.hook(`/${BOT}`, update)).status, 200);
  assert.deepEqual(project.appended[0], {
    path: STREAM,
    event: {
      type: "telegram/update",
      idempotencyKey: `telegram:${BOT}:900`,
      payload: { bot: BOT, update },
    },
  });
});

test("a wrong, missing or other bot's token, an unknown or malformed bot, or a GET is refused and stores nothing", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  const update = { update_id: 1, message: message() };
  for (const [path, token] of [
    [`/${BOT}`, "wrong"],
    [`/${BOT}`, null],
    ["/elsewhere", "s3cret"],
    ["/Iterate-Bot", "s3cret"],
    ["/", "s3cret"],
    ["", "s3cret"],
  ] as const)
    assert.equal((await project.hook(path, update, token)).status, 404, `${path} ${token}`);
  const get = await project.page(`/${BOT}`);
  assert.equal(get.status, 405);
  assert.deepEqual(project.appended, []);
  assert.deepEqual(project.agents, []);
});

test("an authenticated body with no update_id, or not JSON, is acknowledged and dropped", async () => {
  const project = fakeProject();
  await project.connected();
  for (const body of ["{}", "nope", JSON.stringify({ update_id: "1" })]) {
    const res = await project.hook(`/${BOT}`, body);
    assert.equal(res.status, 200);
    assert.notEqual(((await res.json()) as any).ignored, undefined);
  }
  assert.deepEqual(project.appended, []);
});

// ---------------------------------------------------------------- private

test("an allowed person's message wakes the chat's agent, with typing in the chat, once however often Telegram resends", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  const update = { update_id: 10, message: message({ text: "what's on today?" }) };
  for (let delivery = 0; delivery < 2; delivery++) await project.hook(`/${BOT}`, update);
  const added = agentEvents(project);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.path, `/agents/telegram/${BOT}/chat-42`);
  assert.equal(added[0]!.event.type, "events.iterate.com/agent/context-added");
  assert.equal(added[0]!.event.idempotencyKey, `telegram:${BOT}:10`);
  assert.equal(added[0]!.event.payload.llmRequestPolicy, undefined); // it wakes the agent
  const content: string = added[0]!.event.payload.content;
  assert.match(content, /Telegram message from Jonas \(@jonas\):/);
  assert.match(content, /what's on today\?/);
  assert.match(content, /getSecret\("\/secrets\/telegram-iterate-bot", \{ field: "token" \}\)/);
  assert.match(content, /chat_id: 42/);
  assert.deepEqual(sent(project, "sendChatAction")[0]!.body, { chat_id: 42, action: "typing" });
});

test("a photo or document is described with its file_id, a photo's largest size; a topic's thread is named in the reply", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  const withFiles = message({
    text: undefined,
    caption: "my receipt",
    message_thread_id: 9,
    photo: [{ file_id: "small" }, { file_id: "big" }],
    document: { file_id: "doc1" },
  });
  await project.hook(`/${BOT}`, { update_id: 11, message: withFiles });
  const content: string = agentEvents(project)[0]!.event.payload.content;
  assert.match(content, /my receipt/);
  assert.match(content, /Attached: photo, file_id big/);
  assert.match(content, /Attached: document, file_id doc1/);
  assert.match(content, /message_thread_id: 9/);
  assert.equal(sent(project, "sendChatAction")[0]!.body.message_thread_id, 9);
});

test("a stranger is told once that the bot is private, waits on the page, and reaches no agent", async () => {
  const project = fakeProject();
  await project.connected();
  await project.hook(`/${BOT}`, {
    update_id: 20,
    message: message({}, { id: 555, first_name: "Eve" }),
  });
  await project.hook(`/${BOT}`, {
    update_id: 21,
    message: message({ text: "hello?" }, { id: 555, first_name: "Eve" }),
  });
  assert.equal(sent(project).length, 1);
  assert.match(sent(project)[0]!.body.text, /private/);
  assert.equal(sent(project)[0]!.body.chat_id, 42);
  assert.deepEqual(agentEvents(project), []);
  assert.equal(JSON.parse(project.kv(STREAM)["pending/555"]!).name, "Eve");
});

test("an invite lets in whoever opens it, once, and welcomes them; a spent, expired or wrong one does not", async () => {
  const project = fakeProject();
  await project.connected();
  const made = await project.page("/_/invite", { form: { bot: BOT } });
  const code = new URL(made.headers.get("location")!, "https://x.example/_/").searchParams.get(
    "invite",
  )!;
  assert.match(code, /^[0-9a-f]{32}$/);

  await project.hook(`/${BOT}`, {
    update_id: 30,
    message: message({ text: `/start ${code}` }, { id: 77, first_name: "Wife" }),
  });
  assert.equal(JSON.parse(project.kv(STREAM)["allowed/77"]!).name, "Wife");
  assert.match(sent(project).at(-1)!.body.text, /You're in/);
  assert.equal(project.kv(STREAM)[`invite/${code}`], undefined);

  // spent: the next person with the link is a stranger
  await project.hook(`/${BOT}`, {
    update_id: 31,
    message: message({ text: `/start ${code}` }, { id: 88 }),
  });
  assert.equal(project.kv(STREAM)["allowed/88"], undefined);
  assert.match(sent(project).at(-1)!.body.text, /private/);

  // expired
  project.kv(STREAM)["invite/aaaa"] = String(Date.now() - 1000);
  await project.hook(`/${BOT}`, {
    update_id: 32,
    message: message({ text: "/start aaaa" }, { id: 99 }),
  });
  assert.equal(project.kv(STREAM)["allowed/99"], undefined);
  assert.equal(project.kv(STREAM)["invite/aaaa"], undefined);
});

test("an allowed person who taps Start again is welcomed, and it wakes no agent", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  await project.hook(`/${BOT}`, { update_id: 40, message: message({ text: "/start" }) });
  assert.match(sent(project)[0]!.body.text, /You're in/);
  assert.deepEqual(agentEvents(project), []);
});

// ----------------------------------------------------------------- groups

test("in a group an allowed person's @mention, reply to the bot, or command wakes the agent, which is told to reply to that message", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME, 77: WIFE });
  await project.hook(`/${BOT}`, {
    update_id: 50,
    message: group({ text: "@iterate_bot what's for dinner?" }),
  });
  await project.hook(`/${BOT}`, {
    update_id: 51,
    message: group({ text: "and tomorrow?", reply_to_message: { from: { id: 1001 } } }, { id: 77 }),
  });
  await project.hook(`/${BOT}`, { update_id: 52, message: group({ text: "/shopping" }) });
  const added = agentEvents(project);
  assert.equal(added.length, 3);
  assert.ok(added.every((a) => a.path === `/agents/telegram/${BOT}/chat--100`));
  assert.ok(added.every((a) => a.event.payload.llmRequestPolicy === undefined));
  assert.match(added[0]!.event.payload.content, /in the group "Home"/);
  assert.match(added[0]!.event.payload.content, /reply_parameters: \{ message_id: 7 \}/);
  assert.match(added[0]!.event.payload.content, /You are @Iterate_Bot/);
  assert.equal(sent(project, "sendChatAction").length, 3);
});

test("in a group what is not for the bot is read as context only: it wakes nothing and nothing says typing", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  await project.hook(`/${BOT}`, { update_id: 60, message: group({ text: "we need milk" }) });
  const added = agentEvents(project);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0]!.event.payload.llmRequestPolicy, { behaviour: "dont-trigger-request" });
  assert.deepEqual(project.calls, []);
});

test("in a group a stranger who addresses the bot waits on the page and gets no reply; a stranger's chatter, and other bots, are ignored", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  await project.hook(`/${BOT}`, {
    update_id: 70,
    message: group({ text: "@iterate_bot hi" }, { id: 555, first_name: "Eve" }),
  });
  await project.hook(`/${BOT}`, {
    update_id: 71,
    message: group({ text: "just talking" }, { id: 556 }),
  });
  await project.hook(`/${BOT}`, {
    update_id: 72,
    message: group({ text: "@iterate_bot hi" }, { id: 557, is_bot: true }),
  });
  assert.deepEqual(
    Object.keys(project.kv(STREAM)).filter((k) => k.startsWith("pending/")),
    ["pending/555"],
  );
  assert.equal(JSON.parse(project.kv(STREAM)["pending/555"]!).chatTitle, "Home");
  assert.deepEqual(project.calls, []);
  assert.deepEqual(agentEvents(project), []);
});

// ------------------------------------------------------------------- page

test("the page is for members: whatever requireMember answers is sent, and nothing is read or written", async () => {
  const project = fakeProject();
  const refused = new Response("Sign in\n", { status: 401 });
  for (const [path, form] of [
    ["/_/", undefined],
    ["/_/connect", { token: TOKEN }],
  ] as const) {
    const res = await project.page(path, { form }, () => refused);
    assert.equal(res.status, 401);
  }
  assert.deepEqual(project.secrets, {});
  assert.deepEqual(project.calls, []);
});

test("with no bot the page shows the BotFather steps and the token form", async () => {
  const project = fakeProject();
  const res = await project.page("/_/");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /https:\/\/t\.me\/BotFather/);
  assert.match(html, /\/newbot/);
  assert.match(html, /<form method="post" action="connect">/);
  assert.match(res.headers.get("content-security-policy")!, /form-action 'self'/);
});

test("pasting a token checks it, keeps it as a secret, and registers the webhook with a secret the project keeps", async () => {
  const project = fakeProject();
  const res = await project.page("/_/connect", { form: { token: ` ${TOKEN} ` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "./?connected=Iterate_Bot");
  assert.deepEqual(project.secrets[`/secrets/telegram-${BOT}`], {
    material: { token: TOKEN },
    options: { urls: ["https://api.telegram.org"] },
  });
  const webhookSecret = (project.secrets[`/secrets/telegram-webhook-${BOT}`] as any).material;
  assert.match(webhookSecret, /^[0-9a-f]{64}$/);
  const set = sent(project, "setWebhook")[0]!;
  assert.equal(set.credential, `getSecret("/secrets/telegram-${BOT}", { field: "token" })`);
  assert.deepEqual(set.body, {
    url: `https://telegram--iterate.example/${BOT}`,
    secret_token: webhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  assert.deepEqual(
    project.calls.map((c) => c.method),
    ["getMe", "setWebhook"],
  );
  // and a delivery carrying that secret is accepted
  assert.equal(
    (await project.hook(`/${BOT}`, { update_id: 1, message: message() }, webhookSecret)).status,
    200,
  );
  // the page now shows the bot
  assert.match(await (await project.page("/_/")).text(), /@Iterate_Bot/);
});

test("the webhook URL keeps the base path a paths ingress strips", async () => {
  const project = fakeProject();
  await project.page("/_/connect", {
    form: { token: TOKEN },
    headers: { "x-iterate-base-path": "/projects/iterate" },
  });
  assert.equal(
    sent(project, "setWebhook")[0]!.body.url,
    `https://telegram--iterate.example/projects/iterate/${BOT}`,
  );
});

test("a token Telegram refuses, or that is not a token, is shown as an error and keeps nothing", async () => {
  const project = fakeProject();
  const refused = await project.page("/_/connect", {
    form: { token: "123456:bad_bad_bad_bad_bad_bad_bad" },
  });
  assert.match(decodeURIComponent(refused.headers.get("location")!), /error=getMe: Unauthorized/);
  const junk = await project.page("/_/connect", { form: { token: "hello" } });
  assert.match(decodeURIComponent(junk.headers.get("location")!), /does not look like a bot token/);
  assert.deepEqual(project.secrets, {});
  const html = await (
    await project.page("/_/?error=" + encodeURIComponent("<script>x</script>"))
  ).text();
  assert.doesNotMatch(html, /<script>x/);
});

test("the owner lets a waiting person in from the page, and the person is welcomed where they wrote; removing them takes the access away", async () => {
  const project = fakeProject();
  await project.connected();
  await project.hook(`/${BOT}`, {
    update_id: 80,
    message: message({}, { id: 555, first_name: "Eve" }),
  });
  assert.match(await (await project.page("/_/")).text(), /Waiting to be let in[\s\S]*Eve/);

  await project.page("/_/allow", { form: { bot: BOT, id: "555" } });
  assert.equal(JSON.parse(project.kv(STREAM)["allowed/555"]!).name, "Eve");
  assert.equal(project.kv(STREAM)["pending/555"], undefined);
  assert.match(sent(project).at(-1)!.body.text, /You're in/);
  assert.equal(sent(project).at(-1)!.body.chat_id, 42);

  await project.hook(`/${BOT}`, { update_id: 81, message: message({ text: "now?" }, { id: 555 }) });
  assert.equal(agentEvents(project).length, 1);

  await project.page("/_/remove", { form: { bot: BOT, id: "555" } });
  assert.equal(project.kv(STREAM)["allowed/555"], undefined);
});

test("an invite link is shown on the page only for a code that exists, for a bot that exists", async () => {
  const project = fakeProject();
  await project.connected();
  const made = await project.page("/_/invite", { form: { bot: BOT } });
  const location = made.headers.get("location")!;
  const html = await (await project.page(`/_/${location.slice(2)}`)).text();
  assert.match(html, /https:\/\/t\.me\/Iterate_Bot\?start=[0-9a-f]{32}/);
  const forged = await (await project.page(`/_/?bot=${BOT}&invite=${"a".repeat(32)}`)).text();
  assert.doesNotMatch(forged, /start=a{32}/);
});

test("disconnecting drops the webhook and the secrets and takes the bot off the page", async () => {
  const project = fakeProject();
  await project.page("/_/connect", { form: { token: TOKEN } });
  await project.page("/_/disconnect", { form: { bot: BOT } });
  assert.ok(sent(project, "deleteWebhook").length === 1);
  assert.deepEqual(project.secrets, {});
  assert.match(await (await project.page("/_/")).text(), /Connect a Telegram bot/);
  // a webhook with the old secret is refused
  assert.equal((await project.hook(`/${BOT}`, { update_id: 1, message: message() })).status, 404);
});

test("a form for a bot that is not connected, or with a bad id, changes nothing", async () => {
  const project = fakeProject();
  await project.connected();
  const unknown = await project.page("/_/allow", { form: { bot: "other", id: "1" } });
  assert.match(decodeURIComponent(unknown.headers.get("location")!), /Unknown bot/);
  const bad = await project.page("/_/allow", { form: { bot: BOT, id: "x; drop" } });
  assert.equal(bad.status, 404);
  assert.deepEqual(Object.keys(project.kv(STREAM)), ["bot"]);
});

// Runs against dist, the package as shipped. `fakeProject` is a project: secrets (a delete of a
// missing one refused as SECRET_NOT_SET, as the platform does), streams with a kv at the root only (a
// sub-context has `append` and nothing else, as the platform's default-deny rewrite rules make it),
// agents, appends that refuse a key used twice for another event (as the platform does; the same
// event again is a no-op), and an egress to a pretend Telegram that records every Bot API call.
// `faults` makes a secret's delete or an append on /integrations fail. `host` is the worker hosting
// the package: a scope per `getItx`, counted.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { telegram } from "../dist/telegram.js";

const BOT = "iterate-bot";
const STREAM = `/integrations/telegram/${BOT}`;
/** A key of the bot's state in the project's kv. */
const K = (key: string): string => `telegram/${BOT}/${key}`;
const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef";
const CONFIGURED = "events.iterate.com/integration/configured";
const CONNECTION_CONFIGURED = "events.iterate.com/integration/connection-configured";

type Call = { method: string; credential: string; body: any };

function fakeProject(deliver?: "agents" | "events", slug?: string) {
  const secrets: Record<string, unknown> = {};
  const kv: Record<string, string> = {};
  const appended: { path: string; event: any }[] = [];
  const agents: string[] = [];
  const calls: Call[] = [];
  const scopes = { opened: 0, disposed: 0 };
  const faults = { deletes: false, registry: 0 };
  let readsAll = false; // Telegram's privacy mode: on until the bot is an admin or it is switched off
  const itx: any = {
    secrets: {
      set: async (path: string, material: unknown, options: unknown) =>
        void (secrets[path] = { material, options }),
      delete: async (path: string) => {
        if (faults.deletes)
          throw Object.assign(new Error("the secret store is unavailable"), {
            code: "UNAVAILABLE",
          });
        if (!(path in secrets))
          throw Object.assign(new Error(`secret ${path}: never set`), { code: "SECRET_NOT_SET" });
        delete secrets[path];
      },
      verifyEquals: async (path: string, { value }: { value: string }) =>
        (secrets[path] as any)?.material === value,
    },
    agents: { create: async (path: string) => void agents.push(path) },
    kv: {
      get: async (key: string) => kv[key] ?? null,
      put: async (key: string, value: string) => void (kv[key] = value),
      delete: async (key: string) => void delete kv[key],
      list: async (prefix = "") => ({
        keys: Object.keys(kv).filter((key) => key.startsWith(prefix)),
      }),
    },
    cd: (path: string) => ({
      append: async (event: any) => {
        if (path === "/integrations" && faults.registry > 0) {
          faults.registry--;
          throw new Error("the registry is unavailable");
        }
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
    fetch: async (request: Request) => {
      const url = decodeURIComponent(request.url);
      const rest = url.slice("https://api.telegram.org/bot".length);
      const method = rest.slice(rest.lastIndexOf("/") + 1);
      const credential = rest.slice(0, rest.lastIndexOf("/"));
      calls.push({ method, credential, body: JSON.parse(await request.text()) });
      if (credential.includes("bad"))
        return Response.json({ ok: false, error_code: 401, description: "Unauthorized" });
      if (method === "getMe")
        return Response.json({
          ok: true,
          result: {
            id: 1001,
            username: "Iterate_Bot",
            first_name: "Iterate",
            can_read_all_group_messages: readsAll,
          },
        });
      return Response.json({ ok: true, result: true });
    },
  };
  const integration = telegram({ deliver, slug });
  const host = (requireMember: (request: Request) => Response | null) => ({
    getItx: () => {
      scopes.opened++;
      return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
    },
    auth: { require: requireMember },
  });
  const serve = (request: Request, requireMember: (r: Request) => Response | null) =>
    integration.fetch!(request, host(requireMember));
  const hook = async (path: string, body: unknown, token: string | null = "s3cret") =>
    serve(
      new Request(`https://telegram--iterate.example${path}`, {
        method: "POST",
        headers: token === null ? {} : { "x-telegram-bot-api-secret-token": token },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      () => null,
    );
  const connected = async (allowed: Record<string, object> = {}) => {
    secrets[`/secrets/telegram-webhook-${BOT}`] = { material: "s3cret" };
    kv[K("bot")] = JSON.stringify({ id: 1001, username: "Iterate_Bot" });
    kv[`telegram/bots/${BOT}`] = "Iterate_Bot";
    for (const [id, person] of Object.entries(allowed))
      kv[K(`allowed/${id}`)] = JSON.stringify(person);
  };
  const page = async (
    path: string,
    init: { form?: Record<string, string>; headers?: Record<string, string> } = {},
    requireMember: (request: Request) => Response | null = () => null,
  ) =>
    serve(
      new Request(`https://telegram--iterate.example${path}`, {
        method: init.form ? "POST" : "GET",
        headers: { "x-iterate-base-path": "", ...init.headers },
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
      requireMember,
    );
  /** The platform's `project/worker-updated` on `/`, at `offset`: the install hook. */
  const publish = (offset: number) =>
    integration.processEvent!({
      event: { type: "events.iterate.com/project/worker-updated", path: "/", offset },
      itx,
    });
  /** What was registered on `/integrations` for the Dash, in order. */
  const registry = () => appended.filter((a) => a.path === "/integrations").map((a) => a.event);
  return {
    integration,
    itx,
    secrets,
    kv,
    appended,
    agents,
    calls,
    scopes,
    faults,
    hook,
    connected,
    page,
    publish,
    registry,
    readsAll: (on: boolean) => void (readsAll = on),
  };
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

// ------------------------------------------------------------- the integration

test("it answers its own routing slug, telegram unless another is given", () => {
  assert.equal(telegram().routingSlug, "telegram");
  assert.equal(telegram({ slug: "tg" }).routingSlug, "tg");
});

test("each request opens one scope and releases it; a page refused to a non-member opens none", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  await project.hook(`/${BOT}`, { update_id: 1, message: message() });
  await project.page("/_/");
  assert.deepEqual(project.scopes, { opened: 2, disposed: 2 });
  const refused = await project.page("/_/", {}, () => new Response("Sign in\n", { status: 401 }));
  assert.equal(refused.status, 401);
  assert.deepEqual(project.scopes, { opened: 2, disposed: 2 });
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
  assert.equal(JSON.parse(project.kv[K("pending/555")]!).name, "Eve");
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
  assert.equal(JSON.parse(project.kv[K("allowed/77")]!).name, "Wife");
  assert.match(sent(project).at(-1)!.body.text, /You're in/);
  assert.equal(project.kv[K(`invite/${code}`)], undefined);

  // spent: the next person with the link is a stranger
  await project.hook(`/${BOT}`, {
    update_id: 31,
    message: message({ text: `/start ${code}` }, { id: 88 }),
  });
  assert.equal(project.kv[K("allowed/88")], undefined);
  assert.match(sent(project).at(-1)!.body.text, /private/);

  // expired
  project.kv[K("invite/aaaa")] = String(Date.now() - 1000);
  await project.hook(`/${BOT}`, {
    update_id: 32,
    message: message({ text: "/start aaaa" }, { id: 99 }),
  });
  assert.equal(project.kv[K("allowed/99")], undefined);
  assert.equal(project.kv[K("invite/aaaa")], undefined);
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
    Object.keys(project.kv).filter((k) => k.startsWith(K("pending/"))),
    [K("pending/555")],
  );
  assert.equal(JSON.parse(project.kv[K("pending/555")]!).chatTitle, "Home");
  assert.deepEqual(project.calls, []);
  assert.deepEqual(agentEvents(project), []);
});

// ------------------------------------------------------------------- page

test("the page is for members: whatever auth.require answers is sent, and nothing is read or written", async () => {
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
  assert.equal(project.scopes.opened, 0);
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
  assert.match(res.headers.get("content-security-policy")!, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  // no other site can frame it
  assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  // without its slash the page's relative links would lead off it
  const bare = await project.page("/_");
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "_/");
});

test("pasting a token checks it, keeps it as a secret, and registers the webhook with a secret the project keeps", async () => {
  const project = fakeProject();
  const res = await project.page("/_/connect", { form: { token: ` ${TOKEN} ` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "./?connected=Iterate_Bot");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
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
  assert.deepEqual(JSON.parse(project.kv[K("bot")]!), {
    id: 1001,
    username: "Iterate_Bot",
    name: "Iterate",
  });
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
  assert.equal(JSON.parse(project.kv[K("allowed/555")]!).name, "Eve");
  assert.equal(project.kv[K("pending/555")], undefined);
  assert.match(sent(project).at(-1)!.body.text, /You're in/);
  assert.equal(sent(project).at(-1)!.body.chat_id, 42);

  await project.hook(`/${BOT}`, { update_id: 81, message: message({ text: "now?" }, { id: 555 }) });
  assert.equal(agentEvents(project).length, 1);

  await project.page("/_/remove", { form: { bot: BOT, id: "555" } });
  assert.equal(project.kv[K("allowed/555")], undefined);
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
  assert.deepEqual(Object.keys(project.kv).sort(), [`telegram/bots/${BOT}`, K("bot")].sort());
});

// ------------------------------------------------- the group that did not answer

test("in a group saying the bot's name, as a word, is addressing it: its display name, or the first word of its username", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  project.kv[K("bot")] = JSON.stringify({
    id: 1001,
    username: "jeeves_templestein_bot",
    name: "Butler",
  });
  const say = async (id: number, text: string) =>
    project.hook(`/${BOT}`, { update_id: id, message: group({ text }) });
  for (const [id, text] of [
    [100, "Hi Jeeves"],
    [101, "thanks, butler!"],
    [102, "Jeeves, what's for dinner?"],
    [103, "we need milk"],
    [104, "the jeevesome plan"],
    [105, "butlers are great"],
  ] as const)
    await say(id, text);
  const policies = agentEvents(project).map(
    (a) => a.event.payload.llmRequestPolicy?.behaviour ?? "wakes",
  );
  assert.deepEqual(policies, [
    "wakes",
    "wakes",
    "wakes",
    "dont-trigger-request",
    "dont-trigger-request",
    "dont-trigger-request",
  ]);
});

test("a service message (the group was created, someone joined) is not chat: it is recorded and reaches no agent", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  const created = {
    message_id: 1,
    from: { id: 42, is_bot: false, first_name: "Jonas" },
    chat: { id: -100, type: "group", title: "Home" },
    group_chat_created: true,
  };
  const joined = {
    ...created,
    message_id: 2,
    new_chat_members: [{ id: 1001, is_bot: true }],
    group_chat_created: undefined,
  };
  await project.hook(`/${BOT}`, { update_id: 110, message: created });
  await project.hook(`/${BOT}`, { update_id: 111, message: joined });
  assert.equal(project.appended.filter((a) => a.path === STREAM).length, 2);
  assert.deepEqual(project.agents, []);
  assert.deepEqual(project.calls, []);
});

test("a location, with no words, still counts as something said", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME });
  await project.hook(`/${BOT}`, {
    update_id: 120,
    message: message({ text: undefined, location: { latitude: 51.4, longitude: -2.3 } }),
  });
  assert.equal(agentEvents(project).length, 1);
});

// --------------------------------------------------------------- the page

test("every link the page makes has a Copy button, and the page runs one script, under a nonce", async () => {
  const project = fakeProject();
  await project.connected();
  const made = await project.page("/_/invite", { form: { bot: BOT } });
  const res = await project.page(`/_/${made.headers.get("location")!.slice(2)}`);
  const html = await res.text();
  const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy")!)![1];
  assert.match(html, /data-copy="https:\/\/t\.me\/Iterate_Bot\?start=[0-9a-f]{32}"/);
  assert.match(html, /data-copy="https:\/\/t\.me\/Iterate_Bot"/);
  assert.equal(html.match(/<script/g)!.length, 1);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.doesNotMatch(html, /onclick=/);
});

test("the page says whether the bot can read a whole group, and how to fix it when privacy mode is on", async () => {
  const project = fakeProject();
  await project.connected();
  const on = await (await project.page("/_/")).text();
  assert.match(on, /privacy mode is on/);
  assert.match(on, /Add Administrator/);
  // one tap: a link that opens Telegram's group picker and makes the bot an admin, with a Copy button
  assert.match(on, /href="https:\/\/t\.me\/Iterate_Bot\?startgroup&amp;admin=manage_chat"/);
  assert.match(on, /data-copy="https:\/\/t\.me\/Iterate_Bot\?startgroup&amp;admin=manage_chat"/); // &amp; in the attribute: the browser copies &
  assert.doesNotMatch(on, /startgroup=/); // no start parameter: no "/start" lands in the group
  assert.match(on, /\/setprivacy/);
  project.readsAll(true);
  const off = await (await project.page("/_/")).text();
  assert.match(off, /reads every message in a group/);
  assert.match(off, /startgroup&amp;admin=manage_chat/); // and another group is one tap away
  assert.doesNotMatch(off, /privacy mode is on/);
});

// ------------------------------------------- the project routes (deliver: "events")

test("deliver events: a message from someone let in is recorded as accepted, for the project to route, and wakes no agent here", async () => {
  const project = fakeProject("events");
  await project.connected({ 42: ME });
  const msg = message({
    text: "what's for dinner?",
    reply_to_message: { message_id: 3, from: { id: 1001 }, text: "Shall I order?" },
  });
  await project.hook(`/${BOT}`, { update_id: 200, message: msg });
  await project.hook(`/${BOT}`, { update_id: 200, message: msg }); // Telegram's resend
  const accepted = project.appended.filter((a) => a.event.type === "telegram/message-accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.path, STREAM);
  assert.equal(accepted[0]!.event.idempotencyKey, `telegram:${BOT}:200:accepted`);
  assert.deepEqual(accepted[0]!.event.payload, {
    bot: BOT,
    updateId: 200,
    messageId: 7,
    chat: { id: 42, type: "private", title: undefined },
    from: { id: 42, name: "Jonas", username: "jonas" },
    text: "what's for dinner?",
    replyTo: { messageId: 3, fromId: 1001, text: "Shall I order?" },
    addressed: true,
  });
  assert.deepEqual(project.agents, []);
  assert.deepEqual(agentEvents(project), []);
  assert.deepEqual(project.calls, []); // no typing: the project's relay shows it
});

test("deliver events: a group's message is accepted whether or not it addresses the bot, with its files and thread", async () => {
  const project = fakeProject("events");
  await project.connected({ 42: ME });
  await project.hook(`/${BOT}`, { update_id: 210, message: group({ text: "we need milk" }) });
  await project.hook(`/${BOT}`, {
    update_id: 211,
    message: group({
      text: undefined,
      caption: "the sofa",
      message_thread_id: 4,
      photo: [{ file_id: "small" }, { file_id: "big" }],
      document: { file_id: "doc1" },
    }),
  });
  const accepted = project.appended
    .filter((a) => a.event.type === "telegram/message-accepted")
    .map((a) => a.event.payload);
  assert.equal(accepted.length, 2);
  assert.equal(accepted[0].addressed, false);
  assert.deepEqual(accepted[0].chat, { id: -100, type: "supergroup", title: "Home" });
  assert.equal(accepted[1].caption, "the sofa");
  assert.equal(accepted[1].threadId, 4);
  assert.deepEqual(accepted[1].files, [
    { kind: "photo", fileId: "big" },
    { kind: "document", fileId: "doc1" },
  ]);
  assert.deepEqual(agentEvents(project), []);
});

test("deliver events: strangers, other bots and service messages are never accepted; the door still works (invites, welcomes, waiting)", async () => {
  const project = fakeProject("events");
  await project.connected({ 42: ME });
  await project.hook(`/${BOT}`, {
    update_id: 220,
    message: message({}, { id: 555, first_name: "Eve" }),
  });
  await project.hook(`/${BOT}`, { update_id: 221, message: message({}, { is_bot: true }) });
  await project.hook(`/${BOT}`, {
    update_id: 222,
    message: {
      message_id: 9,
      from: { id: 42, is_bot: false, first_name: "Jonas" },
      chat: { id: -100, type: "group", title: "Home" },
      group_chat_created: true,
    },
  });
  await project.hook(`/${BOT}`, { update_id: 223, message: message({ text: "/start" }) });
  assert.deepEqual(
    project.appended.filter((a) => a.event.type === "telegram/message-accepted"),
    [],
  );
  assert.match(sent(project)[0]!.body.text, /private/); // the stranger is told once
  assert.ok(project.kv[K("pending/555")]); // and waits on the page
  assert.match(sent(project)[1]!.body.text, /You're in/); // an allowed person's /start is welcomed
});

test("the package exports what a project needs to send its own answers: api, placeholder, splitText", async () => {
  const lib = await import("../dist/telegram.js");
  assert.equal(typeof lib.api, "function");
  assert.equal(
    lib.placeholder("jeeves"),
    'getSecret("/secrets/telegram-jeeves", { field: "token" })',
  );
  assert.deepEqual(lib.splitText("hi"), ["hi"]);
  const long = Array.from({ length: 5 }, (_, i) => String(i).repeat(1500)).join("\n");
  const pieces = lib.splitText(long);
  assert.ok(pieces.length >= 2 && pieces.every((p: string) => p.length <= 4096));
  assert.equal(pieces.join("\n"), long);
  assert.ok(lib.splitText("😀".repeat(3000)).every((p: string) => !/[\ud800-\udbff]$/.test(p)));
});

// --------------------------------------------- the Dash's Integrations page

const card = (status: object, label: string, routingSlug = "telegram") => ({
  title: "Telegram",
  description:
    "A Telegram bot for private chats and groups, each handed to an agent. Invite links let people in.",
  status,
  actions: [{ label, routingSlug, path: "/_/" }],
});
const row = (people: string, routingSlug = "telegram") => ({
  account: "@Iterate_Bot",
  status: { kind: "ok" },
  actions: [
    { label: "Manage", routingSlug, path: "/_/" },
    { label: "Open", url: "https://t.me/Iterate_Bot" },
  ],
  details: { "Let in": people },
});

test("the install hook registers the card and a row per bot it knows, keyed by the event's path and offset: a retry appends nothing new", async () => {
  const project = fakeProject();
  await project.connected({ 42: ME, 77: WIFE });
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "telegram:registry:/@5",
      payload: { integration: "telegram", card: card({ kind: "ok" }, "Manage") },
    },
    {
      type: CONNECTION_CONFIGURED,
      idempotencyKey: `telegram:registry:${BOT}:/@5`,
      payload: { integration: "telegram", connection: BOT, row: row("2 people") },
    },
  ]);
  // every publish registers again, so a registry that was emptied heals
  await project.publish(9);
  assert.deepEqual(
    project.registry().map((event) => event.idempotencyKey),
    [
      "telegram:registry:/@5",
      `telegram:registry:${BOT}:/@5`,
      "telegram:registry:/@9",
      `telegram:registry:${BOT}:/@9`,
    ],
  );
});

test("with no bot the card asks for one; a hook retried after a change does not fail, and the change registered itself", async () => {
  const project = fakeProject();
  await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "telegram:registry:/@5",
      payload: {
        integration: "telegram",
        card: card({ kind: "attention", text: "Connect a bot" }, "Connect"),
      },
    },
  ]);
  await project.page("/_/connect", { form: { token: TOKEN } });
  await project.publish(5); // the same event again, now with a bot: its card's key is spent
  assert.deepEqual(
    project.registry().map((event) => [event.type, event.idempotencyKey]),
    [
      [CONFIGURED, "telegram:registry:/@5"],
      [CONFIGURED, undefined],
      [CONNECTION_CONFIGURED, undefined],
      [CONNECTION_CONFIGURED, `telegram:registry:${BOT}:/@5`],
    ],
  );
});

test("connecting a bot registers the card again and then its row (a row stands under its card alone); letting people in or out updates the row; disconnecting removes it", async () => {
  const project = fakeProject();
  await project.page("/_/connect", { form: { token: TOKEN } });
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      payload: { integration: "telegram", card: card({ kind: "ok" }, "Manage") },
    },
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "telegram", connection: BOT, row: row("0 people") },
    },
  ]);

  // someone waits, and is let in on the page; then an invite lets in another
  const secret = (project.secrets[`/secrets/telegram-webhook-${BOT}`] as any).material;
  await project.hook(`/${BOT}`, { update_id: 1, message: message({}, { id: 555 }) }, secret);
  await project.page("/_/allow", { form: { bot: BOT, id: "555" } });
  assert.deepEqual(project.registry().at(-1)!.payload.row.details, { "Let in": "1 person" });
  const made = await project.page("/_/invite", { form: { bot: BOT } });
  const code = new URL(made.headers.get("location")!, "https://x.example/_/").searchParams.get(
    "invite",
  );
  await project.hook(
    `/${BOT}`,
    { update_id: 2, message: message({ text: `/start ${code}` }, { id: 77 }) },
    secret,
  );
  assert.deepEqual(project.registry().at(-1)!.payload.row.details, { "Let in": "2 people" });
  await project.page("/_/remove", { form: { bot: BOT, id: "555" } });
  assert.deepEqual(project.registry().at(-1)!.payload.row.details, { "Let in": "1 person" });

  const before = project.registry().length;
  await project.page("/_/disconnect", { form: { bot: BOT } });
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "telegram", connection: BOT, row: null },
    },
    {
      type: CONFIGURED,
      payload: {
        integration: "telegram",
        card: card({ kind: "attention", text: "Connect a bot" }, "Connect"),
      },
    },
  ]);
});

test("the Dash's buttons lead to the slug it answers on; the hook ignores every other event", async () => {
  const project = fakeProject(undefined, "tg");
  await project.page("/_/connect", { form: { token: TOKEN } });
  assert.deepEqual(project.registry()[0]!.payload.card, card({ kind: "ok" }, "Manage", "tg"));
  assert.deepEqual(project.registry()[1]!.payload.row, row("0 people", "tg"));
  const before = project.appended.length;
  for (const type of ["telegram/update", "events.iterate.com/agent/context-added"])
    await project.integration.processEvent!({
      event: { type, path: STREAM, offset: 3 },
      itx: project.itx,
    });
  assert.equal(project.appended.length, before);
});

// ------------------------------------------- a disconnect that does not finish

test("a Disconnect whose secret cannot be deleted says so, and the bot stays listed for another try", async () => {
  const project = fakeProject();
  await project.page("/_/connect", { form: { token: TOKEN } });
  const before = project.registry().length;
  project.faults.deletes = true;
  const failed = await project.page("/_/disconnect", { form: { bot: BOT } });
  assert.match(
    decodeURIComponent(failed.headers.get("location")!),
    /error=the secret store is unavailable/,
  );
  assert.ok(project.secrets[`/secrets/telegram-${BOT}`], "the token stays, and says so");
  assert.ok(project.kv[`telegram/bots/${BOT}`]);
  assert.equal(project.kv[`telegram/removed/${BOT}`], undefined);
  assert.equal(project.registry().length, before, "no row is taken away");
  project.faults.deletes = false;
  assert.equal(
    (await project.page("/_/disconnect", { form: { bot: BOT } })).headers.get("location"),
    "./",
  );
  assert.deepEqual(project.secrets, {});
  assert.equal(project.kv[`telegram/bots/${BOT}`], undefined);
});

test("a Disconnect whose row cannot be taken away leaves a tombstone: Disconnect again, or the next publish, finishes it", async () => {
  for (const finish of ["disconnect", "publish"] as const) {
    const project = fakeProject();
    await project.page("/_/connect", { form: { token: TOKEN } });
    project.faults.registry = 1;
    const failed = await project.page("/_/disconnect", { form: { bot: BOT } });
    assert.match(
      decodeURIComponent(failed.headers.get("location")!),
      /error=the registry is unavailable/,
    );
    assert.deepEqual(project.secrets, {});
    assert.equal(project.kv[`telegram/bots/${BOT}`], undefined);
    assert.ok(
      project.kv[`telegram/removed/${BOT}`],
      "the tombstone stands until the null row lands",
    );
    assert.ok(!project.registry().some((event) => event.payload.row === null));
    if (finish === "disconnect") {
      const again = await project.page("/_/disconnect", { form: { bot: BOT } });
      assert.equal(again.headers.get("location"), "./", "not Unknown bot");
      assert.deepEqual(project.registry().at(-2), {
        type: CONNECTION_CONFIGURED,
        payload: { integration: "telegram", connection: BOT, row: null },
      });
    } else {
      await project.publish(9);
      assert.deepEqual(
        project
          .registry()
          .filter((event) => event.payload.connection === BOT)
          .at(-1),
        {
          type: CONNECTION_CONFIGURED,
          idempotencyKey: `telegram:registry:removed:${BOT}:/@9`,
          payload: { integration: "telegram", connection: BOT, row: null },
        },
      );
      assert.deepEqual(
        project.registry().at(-1)!.payload.card,
        card({ kind: "attention", text: "Connect a bot" }, "Connect"),
      );
    }
    assert.equal(project.kv[`telegram/removed/${BOT}`], undefined, finish);
  }
});

test("a bot connected again after a Disconnect that did not finish keeps its row at the next publish", async () => {
  const project = fakeProject();
  await project.page("/_/connect", { form: { token: TOKEN } });
  project.faults.registry = 1;
  await project.page("/_/disconnect", { form: { bot: BOT } });
  assert.ok(project.kv[`telegram/removed/${BOT}`]);
  await project.page("/_/connect", { form: { token: TOKEN } });
  assert.equal(project.kv[`telegram/removed/${BOT}`], undefined);
  await project.publish(9);
  assert.deepEqual(
    project
      .registry()
      .filter((event) => event.payload.connection === BOT)
      .at(-1)!.payload.row,
    row("0 people"),
  );
});

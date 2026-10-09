// Runs against dist, the package as shipped. `fakeProject` is a project: secrets (a catalog that
// answers the public fields a set named and never a secret one, a delete of a missing secret
// refused as SECRET_NOT_SET, and any delete ending the OAuth attempt in flight, as the platform's
// do), a collection link to a pretend Dash, `beginOAuth` and `completeOAuth` as the platform runs
// them for a client of the project's own (a signed state, the redirect composed under the ingress,
// the client secret's placeholder refused unless its secret is pinned to the token endpoint, the
// person named at `account`'s endpoint (a pretend Cloudflare's /user, called with the new token)
// and another person refused (`IDENTITY_CONFLICT`) when `expectAccount` names one, and the same
// callback again answering the same), a kv, appends that refuse a key used twice for another event
// (as the platform does; the same event again is a no-op), and its egress: the global `fetch` of a
// loaded worker, which answers the one call the package makes, Cloudflare's /accounts with a
// connection's placeholder, and records every call. `faults` makes a secret's delete or an append
// on /integrations fail. `host` is the worker hosting the package: a scope per `getItx`, counted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vite-plus/test";
import { DEPLOY_SCOPES, cloudflare } from "../dist/cloudflare.js";

const ORIGIN = "https://cloudflare--iterate.example";
const CLIENT_ID = "0123456789abcdef0123456789abcdef";
/** The client as the Dash's form saves it: one secret, its ID a public field beside its secret. */
const APP_SECRET = {
  material: { clientId: CLIENT_ID, clientSecret: "a-made-up-secret" },
  options: { urls: ["https://dash.cloudflare.com"], public: ["clientId"] },
};
/** The secret alone, with no public client ID: set by hand, or saved by the package before it asked
 *  for the ID on the same form. */
const SECRET_ALONE = {
  material: { clientSecret: "a-made-up-secret" },
  options: { urls: ["https://dash.cloudflare.com"] },
};
const URLS = ["https://dash.cloudflare.com", "https://api.cloudflare.com"];
const PLACEHOLDER = 'getSecret("/secrets/own-cloudflare-app", { field: "clientSecret" })';
const USER = "https://api.cloudflare.com/client/v4/user";
const ACCOUNTS = "https://api.cloudflare.com/client/v4/accounts?per_page=50";
const CONFIGURED = "events.iterate.com/integration/configured";
const CONNECTION_CONFIGURED = "events.iterate.com/integration/connection-configured";
const DASH_LINK =
  "https://dash.example/collect-secret/iterate?path=%2Fsecrets%2Fown-cloudflare-app";
const PATTERN = String.raw`[0-9a-f]{32}`;
const SCOPES = ["user-details.read", "offline_access"];

type Person = { id: string; email: string; company: string };
const ADA: Person = { id: "1001", email: "ada@example.com", company: "Ada Co" };
const GRACE: Person = { id: "1002", email: "grace@example.com", company: "Grace Co" };
type Call = { url: string; headers: Record<string, string> };
/** The account `completeOAuth` answers: its id, and its name when the endpoint has one. */
type Named = { id: string; name: string | null };

/** The account a JSON answer names at a lookup's dotted paths, as the platform reads it: a
 *  non-empty id, and the name when its path finds a non-empty string. */
function accountAt(json: unknown, lookup: { id: string; name?: string }): Named {
  const at = (path: string) => path.split(".").reduce<any>((value, key) => value?.[key], json);
  const id = at(lookup.id);
  if (typeof id !== "string" || !id)
    throw new Error(`the account endpoint named no account at ${lookup.id}`);
  const name = lookup.name ? at(lookup.name) : null;
  return { id, name: typeof name === "string" && name ? name : null };
}

/** The kv key the package keeps an attempt under: the SHA-256 of its state. */
const pendingKey = (state: string) =>
  `own-cloudflare/pending/${createHash("sha256").update(state).digest("hex")}`;

function fakeProject(options: { slug?: string; scopes?: string[]; urls?: string[] } = {}) {
  const secrets: Record<string, { material: any; options: any }> = {};
  const kv: Record<string, string> = {};
  const appended: { path: string; event: any }[] = [];
  const calls: Call[] = [];
  const collected: any[] = [];
  const begun: { path: string; options: any }[] = [];
  const completed: { path: string; input: { code: string; state: string } }[] = [];
  const scopes = { opened: 0, disposed: 0 };
  // the platform: each secret's attempt in flight, each completed attempt's answer, and the origin
  // it composes the redirect URI under (the deployment's ingress, never a primary hostname)
  const platform = {
    attempts: {} as Record<string, { options: any; state: string }>,
    answers: {} as Record<string, { path: string; scopes: string[]; account?: Named }>,
    redirectOrigin: ORIGIN,
    states: 0,
    /** Whether it calls `account`'s endpoint: a platform older than the option ignores it, and
     *  names no account. */
    lookups: true,
  };
  // Cloudflare: whom each code and token is for, and whether /accounts answers
  const cloudflare_ = {
    codes: {} as Record<string, Person>,
    tokens: {} as Record<string, Person>,
    mints: 0,
    accountsAnswer: true,
  };
  const faults = { deletes: false, registry: 0 };
  /** Every secret path the package began OAuth on, and every kv key it wrote, for the names test. */
  const written = { secrets: new Set<string>(), kv: new Set<string>() };
  const itx: any = {
    secrets: {
      delete: async (path: string) => {
        if (faults.deletes)
          throw Object.assign(new Error("the secret store is unavailable"), {
            code: "UNAVAILABLE",
          });
        delete platform.attempts[path]; // an attempt in flight dies with the delete
        if (!secrets[path])
          throw Object.assign(new Error(`secret ${path}: never set`), { code: "SECRET_NOT_SET" });
        delete secrets[path];
      },
      // the catalog: a secret's public fields, as its set named them, and never a secret one
      list: async () =>
        Object.entries(secrets).map(([path, { material, options }]) => ({
          path,
          public: options.public
            ? Object.fromEntries(options.public.map((name: string) => [name, material[name]]))
            : undefined,
        })),
      collectFromUser: async (input: { path: string }) => {
        collected.push(input);
        return { path: input.path, url: DASH_LINK };
      },
      beginOAuth: async (path: string, given: any) => {
        written.secrets.add(path);
        begun.push({ path, options: structuredClone(given) });
        const named = /^getSecret\("([^"]+)", \{ field: "clientSecret" \}\)$/.exec(
          given.clientSecret,
        )?.[1];
        const holder = named ? secrets[named] : undefined;
        if (!holder || !holder.options.urls.includes(new URL(given.tokenEndpoint).origin))
          throw Object.assign(new Error(`secrets: ${named} holds no secret`), {
            code: "INVALID_INPUT",
          });
        // signed claims, as long as the platform's
        const claims = { kind: "secret-oauth", path, n: ++platform.states, pad: "x".repeat(150) };
        const state = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.a-made-up-signature`;
        platform.attempts[path] = { options: structuredClone(given), state };
        const url = new URL(given.authorizationEndpoint);
        const params = {
          ...given.extra,
          response_type: "code",
          client_id: given.clientId,
          redirect_uri: `${platform.redirectOrigin}${given.redirect.path}`,
          state,
          code_challenge: "a-made-up-challenge",
          code_challenge_method: "S256",
          scope: given.scope,
        };
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
        return { authorizationUrl: url.href, nonce: `nonce-${platform.states}` };
      },
      completeOAuth: async (path: string, input: { code: string; state: string }) => {
        completed.push({ path, input });
        // the same callback again answers the same, and exchanges nothing twice
        const answered = platform.answers[input.state];
        if (answered) return answered;
        const attempt = platform.attempts[path];
        if (!attempt || attempt.state !== input.state)
          throw new Error("no pending attempt matches this callback — begin again");
        const person = cloudflare_.codes[input.code];
        if (!person) throw new Error("the token endpoint answered 400 (invalid_grant)");
        const accessToken = `a-made-up-token-${++cloudflare_.mints}`;
        cloudflare_.tokens[accessToken] = person;
        // the account endpoint, called with the new token before anything is stored
        const lookup = platform.lookups ? attempt.options.account : undefined;
        const account = lookup && namedAt(lookup, accessToken);
        const expected = attempt.options.expectAccount;
        if (expected && account?.id !== expected)
          throw Object.assign(
            new Error(
              `the provider authorized a different account (${account?.id}) than this connection's (${expected}); connect it as a new connection instead`,
            ),
            { code: "IDENTITY_CONFLICT" },
          );
        secrets[path] = {
          material: {
            clientId: attempt.options.clientId,
            clientSecret: attempt.options.clientSecret,
            accessToken,
            refreshToken: `a-made-up-refresh-token-${cloudflare_.mints}`,
          },
          options: {
            urls: attempt.options.urls,
            refresh: {
              kind: "oauth-refresh-token",
              tokenEndpoint: attempt.options.tokenEndpoint,
              clientAuth: attempt.options.clientAuth ?? "client_secret_basic",
            },
          },
        };
        delete platform.attempts[path];
        const answer = {
          path,
          scopes: attempt.options.scope.split(" "),
          ...(account && { account }),
        };
        platform.answers[input.state] = answer;
        return answer;
      },
    },
    kv: {
      get: async (key: string) => kv[key] ?? null,
      put: async (key: string, value: string) => {
        written.kv.add(key);
        kv[key] = value;
      },
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
  };
  /** What `account`'s endpoint names for a token, read at its paths as the platform reads them:
   *  Cloudflare answers /user, under `result`. */
  const namedAt = (lookup: { url: string; id: string; name?: string }, token: string): Named => {
    if (lookup.url !== USER) throw new Error("the account lookup answered 404");
    const person = cloudflare_.tokens[token]!;
    return accountAt({ result: { id: person.id, email: person.email } }, lookup);
  };
  /** The project's egress, a loaded worker's global `fetch`: it swaps a connection's placeholder
   *  for its token and answers Cloudflare's /accounts with the one account the person picked;
   *  every call is recorded, and any other is refused. */
  const egress = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    const held = /^Bearer getSecret\("([^"]+)", \{ field: "accessToken" \}\)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const person = held && cloudflare_.tokens[secrets[held]?.material.accessToken];
    if (request.url === ACCOUNTS && person && cloudflare_.accountsAnswer)
      return Response.json({
        success: true,
        result: [{ id: `acc-${person.id}`, name: person.company }],
      });
    return new Response("unexpected\n", { status: 500 });
  };
  const integration = cloudflare(options);
  const serve = (request: Request, requireMember: (r: Request) => Response | null = () => null) => {
    globalThis.fetch = egress as typeof fetch;
    return integration.fetch!(request, {
      getItx: () => {
        scopes.opened++;
        return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
      },
      auth: { require: requireMember },
    });
  };
  const page = (
    path: string,
    init: { form?: Record<string, string>; headers?: Record<string, string> } = {},
    requireMember?: (request: Request) => Response | null,
  ) =>
    serve(
      new Request(`${ORIGIN}${path}`, {
        method: init.form ? "POST" : "GET",
        headers: { "x-iterate-base-path": "", ...init.headers },
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
      requireMember,
    );
  /** The client registered at Cloudflare, and saved on the Dash's one form: its ID public, beside
   *  its secret. */
  const setUp = async () => {
    secrets["/secrets/own-cloudflare-app"] = structuredClone(APP_SECRET);
  };
  /** Press Connect, or Reconnect on `connection`: the state in the link to Cloudflare. */
  const start = async (connection?: string) => {
    const res = await page("/connect", { form: connection ? { id: connection } : {} });
    return new URL(res.headers.get("location")!).searchParams.get("state")!;
  };
  /** Cloudflare's redirect to the callback. */
  const callback = (query: Record<string, string>) =>
    page(`/oauth2/callback?${new URLSearchParams(query).toString()}`);
  /** Connect (or Reconnect `connection`), and come back from Cloudflare as `person`. */
  let codes = 0;
  const connect = async (person: Person = ADA, connection?: string) => {
    const state = await start(connection);
    const code = `a-made-up-code-${++codes}`;
    cloudflare_.codes[code] = person;
    return callback({ code, state });
  };
  /** The connection of the last attempt begun. */
  const lastConnection = () => begun.at(-1)!.path.slice("/secrets/own-cloudflare-".length);
  /** The platform's `project/worker-updated` on `/`, at `offset`: the install hook. */
  const publish = (offset: number) => {
    globalThis.fetch = egress as typeof fetch;
    return integration.processEvent!({
      event: { type: "events.iterate.com/project/worker-updated", path: "/", offset },
      itx,
    });
  };
  /** What was registered on `/integrations` for the Dash, in order, each checked against the
   *  registry's limits: a payload it refuses folds nothing. */
  const registry = () => {
    const events = appended.filter((a) => a.path === "/integrations").map((a) => a.event);
    for (const event of events) assertFits(event);
    return events;
  };
  return {
    integration,
    itx,
    secrets,
    kv,
    appended,
    calls,
    collected,
    begun,
    completed,
    scopes,
    platform,
    faults,
    written,
    cloudflare: cloudflare_,
    serve,
    page,
    setUp,
    start,
    callback,
    connect,
    lastConnection,
    publish,
    registry,
  };
}

/** The registry's limits (iterate/integrations): strict objects, capped strings, at most four
 *  buttons and ten details, and a connection a secret name could end in. */
function assertFits(event: any) {
  const { payload } = event;
  assert.match(payload.integration, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  const action = (button: any) => {
    assert.ok(button.label.length >= 1 && button.label.length <= 40, button.label);
    if ("url" in button) {
      assert.deepEqual(Object.keys(button).sort(), ["label", "url"]);
      assert.match(button.url, /^https?:\/\//);
    } else {
      assert.deepEqual(Object.keys(button).sort(), ["label", "path", "routingSlug"]);
      assert.match(button.path, /^\/(?!\/)/);
    }
  };
  const status = (value: any) => {
    assert.ok(["ok", "attention", "error"].includes(value.kind));
    assert.ok((value.text ?? "").length <= 200);
  };
  if (event.type === CONFIGURED) {
    if (!payload.card) return;
    const { card } = payload;
    for (const key of Object.keys(card))
      assert.ok(["title", "description", "status", "actions"].includes(key), key);
    assert.ok(card.title.length >= 1 && card.title.length <= 80);
    assert.ok((card.description ?? "").length <= 400);
    status(card.status);
    assert.ok(card.actions.length <= 4);
    card.actions.forEach(action);
  } else {
    assert.equal(event.type, CONNECTION_CONFIGURED);
    assert.match(payload.connection, /^(?!\.\.?$)[a-zA-Z0-9._-]{1,64}$/);
    if (!payload.row) return;
    const { row } = payload;
    for (const key of Object.keys(row))
      assert.ok(["account", "status", "actions", "details"].includes(key), key);
    assert.ok(row.account.length >= 1 && row.account.length <= 200, row.account);
    status(row.status);
    assert.ok(row.actions.length <= 4);
    row.actions.forEach(action);
    const details = Object.entries(row.details ?? {});
    assert.ok(details.length <= 10);
    for (const [label, value] of details) {
      assert.ok(label.length >= 1 && label.length <= 40, label);
      assert.ok((value as string).length <= 200, label);
    }
  }
}

const location = (res: Response) => decodeURIComponent(res.headers.get("location") ?? "");
const card = (status: object, label: string, routingSlug = "cloudflare") => ({
  title: "Cloudflare",
  description:
    "The project's own Cloudflare OAuth client: Cloudflare's API as each connected person, on the account they picked at consent (its Workers, D1, KV, R2 and the rest), with tokens the platform refreshes.",
  status,
  actions: [{ label, routingSlug, path: "/" }],
});
const row = (person: Person = ADA, routingSlug = "cloudflare") => ({
  account: person.email,
  status: { kind: "ok" },
  actions: [
    { label: "Manage", routingSlug, path: "/" },
    { label: "Open", url: "https://dash.cloudflare.com/profile" },
  ],
  details: { Account: `${person.company} (acc-${person.id})`, Scopes: SCOPES.join(" ") },
});
const READY = card({ kind: "ok" }, "Manage");
const NO_CLIENT = card(
  { kind: "attention", text: "Create an OAuth client and paste its secret" },
  "Connect",
);
const NO_ACCOUNT = card({ kind: "attention", text: "Connect an account" }, "Connect");

/** A project with Ada connected through the page, and her connection. */
async function connected() {
  const project = fakeProject();
  await project.setUp();
  await project.connect(ADA);
  return { project, connection: project.lastConnection() };
}

// ------------------------------------------------------------- the integration

test("every name the package keeps is its own: no secret or kv key the platform's shared Cloudflare client could own", async () => {
  const { project, connection } = await connected();
  await project.connect(GRACE);
  await project.connect(ADA, connection);
  await project.connect(ADA); // the same person again: the older connection goes
  project.faults.registry = 1; // leaves a tombstone behind, for a while
  await project.page("/disconnect", { form: { id: project.lastConnection() } });
  await project.publish(3);
  assert.equal(project.written.secrets.size, 3);
  for (const path of project.written.secrets)
    assert.match(path, /^\/secrets\/own-cloudflare-[0-9a-f]{8}$/);
  assert.ok(project.written.kv.size >= 6, [...project.written.kv].join(" "));
  for (const key of project.written.kv) assert.match(key, /^own-cloudflare\//);
  for (const { path } of project.appended) assert.equal(path, "/integrations");
});

test("it answers its own routing slug, cloudflare unless another is given; anything but its page and callback is a 404", async () => {
  assert.equal(cloudflare().routingSlug, "cloudflare");
  assert.equal(cloudflare({ slug: "cf" }).routingSlug, "cf");
  const project = fakeProject();
  for (const path of ["/nope", "/oauth2/callbacks", "/webhook", "/oauth2"])
    assert.equal((await project.page(path)).status, 404, path);
  assert.equal((await project.page("/nope", { form: {} })).status, 404);
  assert.equal((await project.page("/oauth2/callback", { form: {} })).status, 405);
  // a member's stray path opens the project's scope and releases it, and writes nothing
  assert.equal(project.scopes.opened, project.scopes.disposed);
  assert.deepEqual(project.kv, {});
});

test("the page and the callback are for members: whatever auth.require answers is sent, and nothing is read or written", async () => {
  const project = fakeProject();
  const refused = () => new Response("Sign in\n", { status: 401 });
  for (const [path, form] of [
    ["/", undefined],
    ["/connect", {}],
    ["/disconnect", { id: "0a1b2c3d" }],
    ["/oauth2/callback?code=x&state=y", undefined],
  ] as const)
    assert.equal((await project.page(path, { form }, refused)).status, 401, path);
  assert.deepEqual(project.kv, {});
  assert.deepEqual(project.secrets, {});
  assert.deepEqual(project.begun, []);
  assert.deepEqual(project.calls, []);
  assert.equal(project.scopes.opened, 0);
});

// ------------------------------------------------------------------- the page

test("the page shows the redirect URI to register at Cloudflare and the request that registers a client with it, from the request's origin and the base path a paths ingress strips; a form may lead only here and to Cloudflare", async () => {
  const project = fakeProject();
  const res = await project.page("/", {
    headers: { "x-iterate-base-path": "/projects/iterate/cloudflare" },
  });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes(`data-copy="${ORIGIN}/projects/iterate/cloudflare/oauth2/callback"`));
  assert.match(html, /\/oauth_clients/);
  assert.match(html, /OAuth Clients Write/);
  assert.match(html, /client_secret_post/);
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /form-action 'self' https:\/\/dash\.cloudflare\.com;/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
  assert.equal(html.match(/<script/g)!.length, 1);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.doesNotMatch(html, /onclick=/);
});

test("the page links to the Dash's one form for the client, its ID public beside its secret, which never passes through this code; the form checks the ID's shape as the browser does", async () => {
  const project = fakeProject();
  const html = await (await project.page("/")).text();
  assert.ok(html.includes(`href="${DASH_LINK.replace(/&/g, "&amp;")}"`));
  assert.match(html, />Save the client</);
  assert.match(project.collected[0]!.description, /32 hex/);
  assert.deepEqual(
    project.collected.map((input) => ({ ...input, description: undefined })),
    [
      {
        path: "/secrets/own-cloudflare-app",
        egress: { urls: ["https://dash.cloudflare.com"] },
        description: undefined,
        fields: [
          {
            name: "clientId",
            label: "Client ID",
            public: true,
            placeholder: "0123456789abcdef0123456789abcdef",
            pattern: PATTERN,
          },
          { name: "clientSecret", label: "Client secret" },
        ],
        redirectUrl: `${ORIGIN}/`,
      },
    ],
  );
  const shape = new RegExp(`^(?:${PATTERN})$`, "v");
  assert.match(CLIENT_ID, shape);
  for (const value of ["a-made-up-secret", "0123456789ABCDEF0123456789abcdef", ""])
    assert.doesNotMatch(value, shape);
  await project.setUp();
  assert.match(await (await project.page("/")).text(), />Replace it</);
});

test("a secret without the public field is not set up: the page asks to save the client again, and Connect is refused", async () => {
  const project = fakeProject();
  project.secrets["/secrets/own-cloudflare-app"] = structuredClone(SECRET_ALONE);
  const html = await (await project.page("/")).text();
  assert.match(html, /has no public client ID\. Save the client again/);
  assert.doesNotMatch(html, /action="connect"/);
  assert.match(
    location(await project.page("/connect", { form: {} })),
    /error=Save the client first/,
  );
  assert.deepEqual(project.begun, []);
});

// ------------------------------------------------------------------ connect

test("Connect begins OAuth with Cloudflare's endpoints, the callback, the scopes, the client secret's placeholder in the token request's body, and /user naming the person; it keeps the attempt by its state", async () => {
  const project = fakeProject();
  await project.setUp();
  const res = await project.page("/connect", { form: {} });
  assert.equal(res.status, 303);
  const to = new URL(res.headers.get("location")!);
  assert.equal(to.origin + to.pathname, "https://dash.cloudflare.com/oauth2/auth");
  const connection = project.lastConnection();
  assert.match(connection, /^[0-9a-f]{8}$/);
  assert.deepEqual(project.begun, [
    {
      path: `/secrets/own-cloudflare-${connection}`,
      options: {
        authorizationEndpoint: "https://dash.cloudflare.com/oauth2/auth",
        tokenEndpoint: "https://dash.cloudflare.com/oauth2/token",
        clientId: CLIENT_ID,
        clientSecret: PLACEHOLDER,
        redirect: { routingSlug: "cloudflare", path: "/oauth2/callback" },
        clientAuth: "client_secret_post",
        scope: "user-details.read offline_access",
        urls: URLS,
        account: { url: USER, id: "result.id", name: "result.email" },
      },
    },
  ]);
  const attempt = JSON.parse(project.kv[pendingKey(to.searchParams.get("state")!)]!);
  assert.equal(attempt.connection, connection);
  assert.ok(Math.abs(Date.now() - attempt.at) < 5000);
  assert.equal(
    Object.keys(project.kv).filter((key) => key.startsWith("own-cloudflare/accounts/")).length,
    0,
  );
});

test("scopes and urls ask for more, beside the package's own: DEPLOY_SCOPES is what a deploy of iterate needs; the page lists every scope", async () => {
  const project = fakeProject({ scopes: DEPLOY_SCOPES, urls: ["https://api.cloudflare.com"] });
  await project.setUp();
  await project.start();
  const { options } = project.begun[0]!;
  assert.equal(options.scope, [...SCOPES, ...DEPLOY_SCOPES].join(" "));
  assert.deepEqual(options.urls, URLS);
  assert.ok(DEPLOY_SCOPES.includes("workers-scripts.write"));
  assert.ok(DEPLOY_SCOPES.includes("secrets-store.write"));
  assert.match(await (await project.page("/")).text(), /<code>workers-scripts\.write<\/code>/);
});

test("after a Connect whose redirect URI is not the page's own address (a primary hostname), the page shows the one the platform sent Cloudflare too", async () => {
  const project = fakeProject();
  await project.setUp();
  project.platform.redirectOrigin = "https://cloudflare--iterate.ingress.example";
  await project.start();
  const html = await (await project.page("/")).text();
  assert.match(html, /the platform sent Cloudflare this one/);
  assert.ok(
    html.includes('data-copy="https://cloudflare--iterate.ingress.example/oauth2/callback"'),
  );
});

// --------------------------------------------------------------- the callback

test("the callback completes the attempt, keeps the person the platform named and the account their token reaches (one call to /accounts with the placeholder), registers the card then the row, and sends the person back", async () => {
  const project = fakeProject();
  await project.setUp();
  const state = await project.start();
  const connection = project.lastConnection();
  const path = `/secrets/own-cloudflare-${connection}`;
  project.cloudflare.codes["a-made-up-code"] = ADA;
  const before = project.registry().length;
  const res = await project.callback({ code: "a-made-up-code", state });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "../?connected=ada%40example.com");
  assert.deepEqual(project.completed, [{ path, input: { code: "a-made-up-code", state } }]);
  assert.deepEqual(project.secrets[path]!.options.urls, URLS);
  assert.deepEqual(project.calls, [
    {
      url: ACCOUNTS,
      headers: { authorization: `Bearer getSecret("${path}", { field: "accessToken" })` },
    },
  ]);
  const account = JSON.parse(project.kv[`own-cloudflare/accounts/${connection}`]!);
  assert.deepEqual(
    { ...account, at: undefined },
    {
      account: "ada@example.com",
      externalId: "1001",
      scopes: SCOPES,
      accounts: [{ id: "acc-1001", name: "Ada Co" }],
      at: undefined,
    },
  );
  assert.equal(project.kv[pendingKey(state)], undefined);
  assert.deepEqual(project.registry().slice(before), [
    { type: CONFIGURED, payload: { integration: "cloudflare", card: READY } },
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "cloudflare", connection, row: row() },
    },
  ]);
  const html = await (await project.page("/?connected=ada%40example.com")).text();
  assert.match(html, /Connected ada@example\.com\./);
  assert.match(html, /on Ada Co \(acc-1001\)/);
  assert.match(html, />Reconnect</);
  assert.match(html, />Disconnect</);
});

test("a connection whose /accounts does not answer still stands, with no account listed", async () => {
  const project = fakeProject();
  await project.setUp();
  project.cloudflare.accountsAnswer = false;
  await project.connect(ADA);
  const account = JSON.parse(project.kv[`own-cloudflare/accounts/${project.lastConnection()}`]!);
  assert.deepEqual(account.accounts, []);
  assert.equal(project.registry().at(-1)!.payload.row.details.Account, "none listed");
  assert.match(await (await project.page("/")).text(), /on none listed/);
});

test("a callback with an unknown, missing or hour-old state is refused and writes nothing", async () => {
  const project = fakeProject();
  await project.setUp();
  const old = await project.start();
  project.kv[pendingKey(old)] = JSON.stringify({
    connection: project.lastConnection(),
    at: Date.now() - 61 * 60 * 1000,
  });
  const kv = structuredClone(project.kv);
  const before = project.registry().length;
  for (const query of [
    { code: "a-made-up-code", state: "not-a-state" },
    { code: "a-made-up-code" },
    { code: "a-made-up-code", state: old },
  ] as Record<string, string>[]) {
    const res = await project.callback(query);
    assert.match(
      location(res),
      /error=Cloudflare came back from a sign-in this page did not start, or that is over an hour old/,
      JSON.stringify(query),
    );
  }
  assert.deepEqual(project.kv, kv);
  assert.deepEqual(project.completed, []);
  assert.equal(project.registry().length, before);
});

test("a callback with Cloudflare's error forgets the attempt and ends it, and an exchange that fails deletes the pending secret", async () => {
  const project = fakeProject();
  await project.setUp();
  const refused = await project.start();
  const res = await project.callback({ error: "access_denied", state: refused });
  assert.match(location(res), /error=Cloudflare answered access_denied: nothing changed\./);
  assert.deepEqual(project.platform.attempts, {});
  const failed = await project.start();
  const again = await project.callback({ code: "a-code-cloudflare-never-issued", state: failed });
  assert.match(location(again), /error=the token endpoint answered 400 \(invalid_grant\)/);
  assert.deepEqual(Object.keys(project.secrets), ["/secrets/own-cloudflare-app"]);
  assert.equal(
    Object.keys(project.kv).filter((key) => key.startsWith("own-cloudflare/accounts/")).length,
    0,
  );
});

test("the same person connected twice keeps one row: the older connection's secret and row go", async () => {
  const { project, connection: older } = await connected();
  await project.connect(GRACE);
  const grace = project.lastConnection();
  const res = await project.connect(ADA);
  const newer = project.lastConnection();
  assert.notEqual(newer, older);
  assert.equal(res.headers.get("location"), "../?connected=ada%40example.com");
  assert.equal(project.secrets[`/secrets/own-cloudflare-${older}`], undefined);
  assert.equal(project.kv[`own-cloudflare/accounts/${older}`], undefined);
  assert.ok(project.secrets[`/secrets/own-cloudflare-${newer}`]);
  assert.ok(project.secrets[`/secrets/own-cloudflare-${grace}`], "another person stays");
  const html = await (await project.page("/")).text();
  assert.equal(html.match(/<b>ada@example\.com<\/b>/g)!.length, 1);
  assert.match(html, /<b>grace@example\.com<\/b>/);
});

// --------------------------------------------------------------- reconnect

test("Reconnect begins OAuth again on the same connection, held to its person (expectAccount); a Reconnect that comes back as another person is refused before anything is stored", async () => {
  const { project, connection } = await connected();
  const path = `/secrets/own-cloudflare-${connection}`;
  const token = project.secrets[path]!.material.accessToken;
  const res = await project.connect(ADA, connection);
  assert.equal(res.headers.get("location"), "../?connected=ada%40example.com");
  assert.equal(project.lastConnection(), connection);
  assert.equal(project.begun.at(-1)!.options.expectAccount, "1001");
  assert.notEqual(project.secrets[path]!.material.accessToken, token, "new tokens");
  for (const id of ["ffffffff", "not-a-connection"])
    assert.match(
      location(await project.page("/connect", { form: { id } })),
      /error=Unknown connection/,
      id,
    );
  const secrets = structuredClone(project.secrets);
  const kv = structuredClone(project.kv);
  const conflict = await project.connect(GRACE, connection);
  assert.match(
    location(conflict),
    /error=the provider authorized a different account \(1002\) than this connection's \(1001\)/,
  );
  assert.deepEqual(project.secrets, secrets);
  assert.deepEqual(project.kv, kv);
});

// --------------------------------------------------------------- disconnect

test("Disconnect deletes the connection's secret and kv entry, takes its row away and registers the card; a failed delete keeps everything for another try", async () => {
  const { project, connection } = await connected();
  project.faults.deletes = true;
  const refused = await project.page("/disconnect", { form: { id: connection } });
  assert.match(location(refused), /error=the secret store is unavailable/);
  assert.ok(project.secrets[`/secrets/own-cloudflare-${connection}`]);
  project.faults.deletes = false;
  const before = project.registry().length;
  const res = await project.page("/disconnect", { form: { id: connection } });
  assert.equal(res.headers.get("location"), "./");
  assert.equal(project.secrets[`/secrets/own-cloudflare-${connection}`], undefined);
  assert.ok(project.secrets["/secrets/own-cloudflare-app"], "the client's secret stays");
  assert.equal(project.kv[`own-cloudflare/accounts/${connection}`], undefined);
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "cloudflare", connection, row: null },
    },
    { type: CONFIGURED, payload: { integration: "cloudflare", card: NO_ACCOUNT } },
  ]);
  assert.match(await (await project.page("/")).text(), /None yet/);
  for (const id of ["ffffffff", "not-a-connection"])
    assert.match(
      location(await project.page("/disconnect", { form: { id } })),
      /error=Unknown connection/,
    );
});

test("a Disconnect whose row cannot be taken away leaves a tombstone, which the next publish finishes", async () => {
  const { project, connection } = await connected();
  project.faults.registry = 1;
  const failed = await project.page("/disconnect", { form: { id: connection } });
  assert.match(location(failed), /error=the registry is unavailable/);
  assert.ok(project.kv[`own-cloudflare/removed/${connection}`]);
  await project.publish(9);
  assert.deepEqual(
    project
      .registry()
      .filter((event) => event.payload.connection === connection)
      .at(-1),
    {
      type: CONNECTION_CONFIGURED,
      idempotencyKey: `cloudflare:registry:removed:${connection}:/@9`,
      payload: { integration: "cloudflare", connection, row: null },
    },
  );
  assert.equal(project.kv[`own-cloudflare/removed/${connection}`], undefined);
});

// --------------------------------------------- the Dash's Integrations page

test("the install hook registers the card and a row per connection, keyed by the event's path and offset: a retry appends nothing new; the card asks for the client, then for an account, then is ok", async () => {
  const project = fakeProject();
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "cloudflare:registry:/@5",
      payload: { integration: "cloudflare", card: NO_CLIENT },
    },
  ]);
  await project.setUp();
  await project.publish(6);
  assert.deepEqual(project.registry().at(-1)!.payload.card, NO_ACCOUNT);
  await project.connect(ADA);
  const connection = project.lastConnection();
  const before = project.registry().length;
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(9);
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONFIGURED,
      idempotencyKey: "cloudflare:registry:/@9",
      payload: { integration: "cloudflare", card: READY },
    },
    {
      type: CONNECTION_CONFIGURED,
      idempotencyKey: `cloudflare:registry:${connection}:/@9`,
      payload: { integration: "cloudflare", connection, row: row() },
    },
  ]);
});

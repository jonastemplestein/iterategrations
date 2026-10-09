// Runs against dist, the package as shipped. `fakeProject` is a project: secrets (a catalog that
// answers the public fields a set named and never a secret one, a delete of a missing secret
// refused as SECRET_NOT_SET, and any delete ending the OAuth attempt in flight, as the platform's
// do), a collection link to a pretend Dash, `beginOAuth` and `completeOAuth` as the platform runs
// them for a client of the project's own (a signed state, the redirect composed under the ingress,
// the client secret's placeholder refused unless its secret is pinned to the token endpoint, the
// account named at `account`'s endpoint (a pretend Google's userinfo, called with the new token)
// and another account refused (`IDENTITY_CONFLICT`) when `expectAccount` names one, and the same
// callback again answering the same), a kv, appends that refuse a key used twice for another event
// (as the platform does; the same event again is a no-op), and its egress: the global `fetch` of a
// loaded worker, which records every call, since the package makes none. `faults` makes a secret's
// delete or an append on /integrations fail. `host` is the worker hosting the package: a scope per
// `getItx`, counted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vite-plus/test";
import { google } from "../dist/google.js";

const ORIGIN = "https://google--iterate.example";
const CLIENT_ID = "1234-fake.apps.googleusercontent.com";
/** The client as the Dash's form saves it: one secret, its ID a public field beside its secret. */
const APP_SECRET = {
  material: { clientId: CLIENT_ID, clientSecret: "GOCSPX-a-made-up-secret" },
  options: { urls: ["https://oauth2.googleapis.com"], public: ["clientId"] },
};
/** The secret alone, with no public client ID: set by hand, or saved by the package before it asked
 *  for the ID on the same form. */
const SECRET_ALONE = {
  material: { clientSecret: "GOCSPX-a-made-up-secret" },
  options: { urls: ["https://oauth2.googleapis.com"] },
};
const URLS = [
  "https://oauth2.googleapis.com",
  "https://www.googleapis.com",
  "https://gmail.googleapis.com",
];
const PLACEHOLDER = 'getSecret("/secrets/own-google-app", { field: "clientSecret" })';
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";
const CONFIGURED = "events.iterate.com/integration/configured";
const CONNECTION_CONFIGURED = "events.iterate.com/integration/connection-configured";
const DASH_LINK = "https://dash.example/collect-secret/iterate?path=%2Fsecrets%2Fown-google-app";
const PATTERN = String.raw`\d{1,30}-[0-9a-z]{1,64}\.apps\.googleusercontent\.com`;
/** What Google grants for `openid email profile`: the long names of the last two. */
const GRANTED = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

type Person = { id: string; email: string };
const ADA: Person = { id: "1001", email: "ada@example.com" };
const GRACE: Person = { id: "1002", email: "grace@example.com" };
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
  `own-google/pending/${createHash("sha256").update(state).digest("hex")}`;

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
  // Google: whom each code and token is for
  const google_ = {
    codes: {} as Record<string, Person>,
    tokens: {} as Record<string, Person>,
    mints: 0,
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
        const person = google_.codes[input.code];
        if (!person) throw new Error("the token endpoint answered 400 (invalid_grant)");
        const accessToken = `a-made-up-token-${++google_.mints}`;
        google_.tokens[accessToken] = person;
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
            refreshToken: `a-made-up-refresh-token-${google_.mints}`,
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
        const long: Record<string, string> = { email: GRANTED[1]!, profile: GRANTED[2]! };
        const answer = {
          path,
          scopes: attempt.options.scope.split(" ").map((scope: string) => long[scope] ?? scope),
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
   *  Google answers only at its userinfo endpoint. */
  const namedAt = (lookup: { url: string; id: string; name?: string }, token: string): Named => {
    if (lookup.url !== USERINFO) throw new Error("the account lookup answered 404");
    const person = google_.tokens[token]!;
    return accountAt({ id: person.id, email: person.email, verified_email: true }, lookup);
  };
  /** The project's egress, a loaded worker's global `fetch`: the platform names every account, so
   *  the package calls no service, and each call is recorded and refused. */
  const egress = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    return new Response("unexpected\n", { status: 500 });
  };
  const integration = google(options);
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
  /** The client made at Google, and saved on the Dash's one form: its ID public, beside its secret. */
  const setUp = async () => {
    secrets["/secrets/own-google-app"] = structuredClone(APP_SECRET);
  };
  /** Press Connect, or Reconnect on `connection`: the state in the link to Google. */
  const start = async (connection?: string) => {
    const res = await page("/connect", { form: connection ? { id: connection } : {} });
    return new URL(res.headers.get("location")!).searchParams.get("state")!;
  };
  /** Google's redirect to the callback. */
  const callback = (query: Record<string, string>) =>
    page(`/oauth2/callback?${new URLSearchParams(query).toString()}`);
  /** Connect (or Reconnect `connection`), and come back from Google as `person`. */
  let codes = 0;
  const connect = async (person: Person = ADA, connection?: string) => {
    const state = await start(connection);
    const code = `a-made-up-code-${++codes}`;
    google_.codes[code] = person;
    return callback({ code, state, scope: "openid email profile" });
  };
  /** The connection of the last attempt begun. */
  const lastConnection = () => begun.at(-1)!.path.slice("/secrets/own-google-".length);
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
    google: google_,
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
const card = (status: object, label: string, routingSlug = "google") => ({
  title: "Google",
  description:
    "The project's own Google OAuth client: Google's APIs (Gmail, Calendar, Drive and the rest) as each connected account, with tokens the platform refreshes.",
  status,
  actions: [{ label, routingSlug, path: "/" }],
});
const row = (account = "ada@example.com", routingSlug = "google") => ({
  account,
  status: { kind: "ok" },
  actions: [
    { label: "Manage", routingSlug, path: "/" },
    { label: "Open", url: "https://myaccount.google.com/permissions" },
  ],
  details: { Scopes: "openid userinfo.email userinfo.profile" },
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

test("every name the package keeps is its own: no secret or kv key the platform's shared Google client could own", async () => {
  const { project, connection } = await connected();
  await project.connect(GRACE);
  await project.connect(ADA, connection);
  await project.connect(ADA); // the same account again: the older connection goes
  project.faults.registry = 1; // leaves a tombstone behind, for a while
  await project.page("/disconnect", { form: { id: project.lastConnection() } });
  await project.publish(3);
  assert.equal(project.written.secrets.size, 3);
  for (const path of project.written.secrets)
    assert.match(path, /^\/secrets\/own-google-[0-9a-f]{8}$/);
  assert.ok(project.written.kv.size >= 6, [...project.written.kv].join(" "));
  for (const key of project.written.kv) assert.match(key, /^own-google\//);
  for (const { path } of project.appended) assert.equal(path, "/integrations");
});

test("it answers its own routing slug, google unless another is given; anything but its page and callback is a 404", async () => {
  assert.equal(google().routingSlug, "google");
  assert.equal(google({ slug: "gmail" }).routingSlug, "gmail");
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

test("each request opens one scope and releases it", async () => {
  const { project } = await connected();
  const before = { ...project.scopes };
  await project.page("/");
  await project.callback({ code: "x", state: "y" });
  assert.deepEqual(project.scopes, { opened: before.opened + 2, disposed: before.disposed + 2 });
});

// ------------------------------------------------------------------- the page

test("the page shows the redirect URI to register at Google, from the request's origin and the base path a paths ingress strips, with a Copy button; a form may lead only here and to Google", async () => {
  const project = fakeProject();
  const res = await project.page("/", {
    headers: { "x-iterate-base-path": "/projects/iterate/google" },
  });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes(`data-copy="${ORIGIN}/projects/iterate/google/oauth2/callback"`));
  assert.match(html, /Web application/);
  assert.match(html, /https:\/\/console\.cloud\.google\.com\/apis\/credentials/);
  assert.match(html, /OAuth consent screen/);
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com;/);
  // no other site may frame it: a framed Disconnect would post from this origin
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
  assert.match(project.collected[0]!.description, /GOCSPX-/);
  assert.deepEqual(
    project.collected.map((input) => ({ ...input, description: undefined })),
    [
      {
        path: "/secrets/own-google-app",
        egress: { urls: ["https://oauth2.googleapis.com"] },
        description: undefined,
        fields: [
          {
            name: "clientId",
            label: "Client ID",
            public: true,
            placeholder: "1234-abc.apps.googleusercontent.com",
            pattern: PATTERN,
          },
          { name: "clientSecret", label: "Client secret" },
        ],
        redirectUrl: `${ORIGIN}/`,
      },
    ],
  );
  // HTML's pattern takes the whole value, compiled with the `v` flag
  const shape = new RegExp(`^(?:${PATTERN})$`, "v");
  for (const id of [CLIENT_ID, "1234-abc.apps.googleusercontent.com"]) assert.match(id, shape);
  for (const value of ["GOCSPX-a-made-up-secret", "1234-fake.apps.example.com", ""])
    assert.doesNotMatch(value, shape);
  await project.setUp();
  assert.match(await (await project.page("/")).text(), />Replace it</);
});

test("the client is read from the catalog's public field: the page shows its ID, Connect sends it, and the kv keeps no copy", async () => {
  const project = fakeProject();
  await project.setUp();
  const html = await (await project.page("/")).text();
  assert.match(html, /Client ID 1234-fake\.apps\.googleusercontent\.com/);
  assert.doesNotMatch(html, /has no public client ID/);
  await project.start();
  assert.equal(project.begun[0]!.options.clientId, CLIENT_ID);
  assert.ok(!Object.values(project.kv).some((value) => value.includes(CLIENT_ID)));
});

test("a secret without the public field is not set up: the page asks to save the client again, and Connect is refused", async () => {
  const project = fakeProject();
  project.secrets["/secrets/own-google-app"] = structuredClone(SECRET_ALONE);
  const html = await (await project.page("/")).text();
  assert.match(html, /has no public client ID\. Save the client again/);
  assert.match(html, />Save the client</);
  assert.doesNotMatch(html, /Client ID 1234/);
  assert.doesNotMatch(html, /action="connect"/);
  assert.match(
    location(await project.page("/connect", { form: {} })),
    /error=Save the client first/,
  );
  assert.deepEqual(project.begun, []);
});

test("no other site can frame the page's answers or the callback's", async () => {
  const { project, connection } = await connected();
  const answers = [
    await project.page("/connect", { form: {} }),
    await project.page("/disconnect", { form: { id: "ffffffff" } }),
    await project.callback({ code: "x", state: "y" }),
    await project.connect(ADA, connection),
  ];
  for (const res of answers) {
    assert.equal(res.headers.get("x-frame-options"), "DENY", res.headers.get("location")!);
    assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  }
});

// ------------------------------------------------------------------ connect

test("Connect needs the client; then it begins OAuth with Google's endpoints, the callback, the scopes, offline access, the client secret's placeholder and the userinfo endpoint that names the account, and keeps the attempt by its state", async () => {
  const project = fakeProject();
  assert.match(
    location(await project.page("/connect", { form: {} })),
    /error=Save the client first/,
  );
  assert.deepEqual(project.begun, []);
  await project.setUp();
  const res = await project.page("/connect", { form: {} });
  assert.equal(res.status, 303);
  const to = new URL(res.headers.get("location")!);
  assert.equal(to.origin + to.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const connection = project.lastConnection();
  assert.match(connection, /^[0-9a-f]{8}$/);
  assert.deepEqual(project.begun, [
    {
      path: `/secrets/own-google-${connection}`,
      options: {
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: CLIENT_ID,
        clientSecret: PLACEHOLDER,
        redirect: { routingSlug: "google", path: "/oauth2/callback" },
        scope: "openid email profile",
        urls: URLS,
        extra: { access_type: "offline", prompt: "consent" },
        account: { url: USERINFO, id: "id", name: "email" },
      },
    },
  ]);
  const attempt = JSON.parse(project.kv[pendingKey(to.searchParams.get("state")!)]!);
  assert.equal(attempt.connection, connection);
  assert.ok(Math.abs(Date.now() - attempt.at) < 5000);
  // nothing is listed until Google comes back
  assert.equal(
    Object.keys(project.kv).filter((key) => key.startsWith("own-google/accounts/")).length,
    0,
  );
  const html = await (await project.page("/")).text();
  assert.match(html, /<form method="post" action="connect">/);
  assert.match(
    html,
    /It asks Google for <code>openid<\/code> <code>email<\/code> <code>profile<\/code>\./,
  );
});

test("scopes and urls ask for more, beside the package's own; the page lists every scope it asks for", async () => {
  const project = fakeProject({
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid"],
    urls: ["https://sheets.googleapis.com", "https://www.googleapis.com"],
  });
  await project.setUp();
  await project.start();
  const { options } = project.begun[0]!;
  assert.equal(
    options.scope,
    "openid email profile https://www.googleapis.com/auth/gmail.readonly",
  );
  assert.deepEqual(options.urls, [...URLS, "https://sheets.googleapis.com"]);
  assert.match(
    await (await project.page("/")).text(),
    /<code>https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly<\/code>/,
  );
});

test("Connect forgets the attempts that never came back, after an hour", async () => {
  const project = fakeProject();
  await project.setUp();
  const stale = await project.start();
  project.kv[pendingKey(stale)] = JSON.stringify({
    connection: project.lastConnection(),
    at: Date.now() - 61 * 60 * 1000,
  });
  const fresh = await project.start();
  const next = await project.start();
  assert.deepEqual(
    Object.keys(project.kv)
      .filter((key) => key.startsWith("own-google/pending/"))
      .sort(),
    [pendingKey(fresh), pendingKey(next)].sort(),
  );
});

test("after a Connect whose redirect URI is not the page's own address (a primary hostname), the page shows the one the platform sent Google too", async () => {
  const project = fakeProject();
  await project.setUp();
  project.platform.redirectOrigin = "https://google--iterate.ingress.example";
  assert.doesNotMatch(await (await project.page("/")).text(), /the platform sent Google/);
  await project.start();
  const html = await (await project.page("/")).text();
  assert.ok(html.includes(`data-copy="${ORIGIN}/oauth2/callback"`));
  assert.match(html, /the platform sent Google this one/);
  assert.ok(html.includes('data-copy="https://google--iterate.ingress.example/oauth2/callback"'));
  assert.equal(
    project.kv["own-google/redirect-uri"],
    "https://google--iterate.ingress.example/oauth2/callback",
  );
});

// --------------------------------------------------------------- the callback

test("the callback completes the attempt, keeps the account the platform named, registers the card then the row, and sends the person back; the package calls no service of its own", async () => {
  const project = fakeProject();
  await project.setUp();
  const state = await project.start();
  const connection = project.lastConnection();
  const path = `/secrets/own-google-${connection}`;
  project.google.codes["a-made-up-code"] = ADA;
  const before = project.registry().length;
  const res = await project.callback({ code: "a-made-up-code", state });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "../?connected=ada%40example.com");
  assert.deepEqual(project.completed, [{ path, input: { code: "a-made-up-code", state } }]);
  // the tokens went no further than the pin the package asked for
  assert.deepEqual(project.secrets[path]!.options.urls, URLS);
  assert.deepEqual(project.calls, []);
  const account = JSON.parse(project.kv[`own-google/accounts/${connection}`]!);
  assert.deepEqual(
    { ...account, at: undefined },
    {
      account: "ada@example.com",
      externalId: "1001",
      scopes: GRANTED,
      at: undefined,
    },
  );
  assert.ok(Math.abs(Date.now() - Date.parse(account.at)) < 5000);
  assert.equal(project.kv[pendingKey(state)], undefined);
  // the card first: a row stands under its card alone
  assert.deepEqual(project.registry().slice(before), [
    { type: CONFIGURED, payload: { integration: "google", card: READY } },
    { type: CONNECTION_CONFIGURED, payload: { integration: "google", connection, row: row() } },
  ]);
  const html = await (await project.page("/?connected=ada%40example.com")).text();
  assert.match(html, /Connected ada@example\.com\./);
  assert.ok(html.includes(`<b>ada@example.com</b> <span class="muted"><code>${path}</code>`));
  assert.match(html, /openid userinfo\.email userinfo\.profile/);
  assert.match(html, />Reconnect</);
  assert.match(html, />Disconnect</);
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
  const secrets = structuredClone(project.secrets);
  const before = project.registry().length;
  const queries: Record<string, string>[] = [
    { code: "a-made-up-code", state: "not-a-state" },
    { code: "a-made-up-code", state: "" },
    { code: "a-made-up-code" },
    { code: "a-made-up-code", state: old },
    { error: "access_denied", state: "not-a-state" },
  ];
  for (const query of queries) {
    const res = await project.callback(query);
    assert.match(
      location(res),
      /error=Google came back from a sign-in this page did not start, or that is over an hour old/,
      JSON.stringify(query),
    );
  }
  assert.deepEqual(project.kv, kv);
  assert.deepEqual(project.secrets, secrets);
  assert.deepEqual(project.completed, []);
  assert.equal(project.registry().length, before);
});

test("a callback with Google's error forgets the attempt and ends it: nothing is connected", async () => {
  const project = fakeProject();
  await project.setUp();
  const state = await project.start();
  const res = await project.callback({ error: "access_denied", state });
  assert.match(location(res), /error=Google answered access_denied: nothing changed\./);
  assert.equal(project.kv[pendingKey(state)], undefined);
  assert.deepEqual(project.platform.attempts, {});
  assert.deepEqual(Object.keys(project.secrets), ["/secrets/own-google-app"]);
  assert.deepEqual(project.completed, []);
});

test("an exchange that fails deletes the pending secret, shows the error, and lists nothing", async () => {
  const project = fakeProject();
  await project.setUp();
  const state = await project.start();
  const before = project.registry().length;
  const res = await project.callback({ code: "a-code-google-never-issued", state });
  assert.match(location(res), /error=the token endpoint answered 400 \(invalid_grant\)/);
  assert.deepEqual(project.platform.attempts, {}, "the attempt is ended");
  assert.deepEqual(Object.keys(project.secrets), ["/secrets/own-google-app"]);
  assert.equal(
    Object.keys(project.kv).filter((key) => key.startsWith("own-google/accounts/")).length,
    0,
  );
  assert.equal(project.registry().length, before);
  const html = await (await project.page(`/${res.headers.get("location")!.slice(3)}`)).text();
  assert.match(html, /class="error">the token endpoint answered 400/);
  assert.match(html, /None yet/);
});

test("a platform that names no account (one older than the account endpoint) connects nothing: the new connection's secret goes", async () => {
  const project = fakeProject();
  await project.setUp();
  project.platform.lookups = false;
  const before = project.registry().length;
  const res = await project.connect(ADA);
  assert.match(location(res), /error=The platform named no account for these tokens/);
  assert.deepEqual(Object.keys(project.secrets), ["/secrets/own-google-app"]);
  assert.equal(
    Object.keys(project.kv).filter((key) => key.startsWith("own-google/accounts/")).length,
    0,
  );
  assert.equal(project.registry().length, before);
});

test("an account the userinfo endpoint names no address for is listed by its id", async () => {
  const project = fakeProject();
  await project.setUp();
  const res = await project.connect({ id: "1004", email: "" });
  assert.equal(res.headers.get("location"), "../?connected=1004");
  const connection = project.lastConnection();
  assert.equal(JSON.parse(project.kv[`own-google/accounts/${connection}`]!).account, "1004");
  assert.equal(project.registry().at(-1)!.payload.row.account, "1004");
});

test("the same account connected twice keeps one row: the older connection's secret and row go", async () => {
  const { project, connection: older } = await connected();
  await project.connect(GRACE);
  const grace = project.lastConnection();
  const before = project.registry().length;
  const res = await project.connect(ADA);
  const newer = project.lastConnection();
  assert.notEqual(newer, older);
  assert.equal(res.headers.get("location"), "../?connected=ada%40example.com");
  assert.equal(project.secrets[`/secrets/own-google-${older}`], undefined);
  assert.equal(project.kv[`own-google/accounts/${older}`], undefined);
  assert.equal(project.kv[`own-google/removed/${older}`], undefined, "its null row landed");
  assert.ok(project.secrets[`/secrets/own-google-${newer}`]);
  assert.ok(project.secrets[`/secrets/own-google-${grace}`], "another account stays");
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "google", connection: older, row: null },
    },
    { type: CONFIGURED, payload: { integration: "google", card: READY } },
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "google", connection: newer, row: row() },
    },
  ]);
  const html = await (await project.page("/")).text();
  assert.equal(html.match(/<b>ada@example\.com<\/b>/g)!.length, 1);
  assert.match(html, /<b>grace@example\.com<\/b>/);
});

// --------------------------------------------------------------- reconnect

test("Reconnect begins OAuth again on the same connection, held to its account (expectAccount) and hinted to Google; the callback keeps the connection", async () => {
  const { project, connection } = await connected();
  const path = `/secrets/own-google-${connection}`;
  const token = project.secrets[path]!.material.accessToken;
  const res = await project.connect(ADA, connection);
  assert.equal(res.headers.get("location"), "../?connected=ada%40example.com");
  assert.equal(project.lastConnection(), connection);
  assert.deepEqual(project.begun.at(-1), {
    path,
    options: {
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      clientId: CLIENT_ID,
      clientSecret: PLACEHOLDER,
      redirect: { routingSlug: "google", path: "/oauth2/callback" },
      scope: "openid email profile",
      urls: URLS,
      extra: { access_type: "offline", prompt: "consent", login_hint: "ada@example.com" },
      account: { url: USERINFO, id: "id", name: "email" },
      expectAccount: "1001",
    },
  });
  assert.notEqual(project.secrets[path]!.material.accessToken, token, "new tokens");
  assert.equal(
    JSON.parse(project.kv[`own-google/accounts/${connection}`]!).account,
    "ada@example.com",
  );
  assert.equal(
    Object.keys(project.kv).filter((key) => key.startsWith("own-google/accounts/")).length,
    1,
  );
  assert.deepEqual(project.registry().at(-1), {
    type: CONNECTION_CONFIGURED,
    payload: { integration: "google", connection, row: row() },
  });
  // an unknown connection is refused before Google is asked
  const begun = project.begun.length;
  for (const id of ["ffffffff", "not-a-connection"])
    assert.match(
      location(await project.page("/connect", { form: { id } })),
      /error=Unknown account/,
      id,
    );
  assert.equal(project.begun.length, begun);
});

test("a Reconnect that comes back as another account, even one connected already, is refused by the platform before anything is stored: the page shows it, and nothing changes", async () => {
  const { project, connection } = await connected();
  await project.connect(GRACE);
  const secrets = structuredClone(project.secrets);
  const kv = structuredClone(project.kv);
  const before = project.registry().length;
  const res = await project.connect(GRACE, connection);
  assert.match(
    location(res),
    /error=the provider authorized a different account \(1002\) than this connection's \(1001\)/,
  );
  assert.deepEqual(project.secrets, secrets);
  assert.deepEqual(project.kv, kv);
  assert.equal(project.registry().length, before);
  const html = await (await project.page(`/${res.headers.get("location")!.slice(3)}`)).text();
  assert.match(html, /class="error">the provider authorized a different account \(1002\)/);
  assert.match(html, /<b>ada@example\.com<\/b>/);
  assert.match(html, /<b>grace@example\.com<\/b>/);
});

test("an account reconnected after a removal that did not finish keeps its row at the next publish", async () => {
  const { project, connection } = await connected();
  // a Disconnect that stopped after its tombstone: the secret gone, the account still listed
  delete project.secrets[`/secrets/own-google-${connection}`];
  project.kv[`own-google/removed/${connection}`] = JSON.stringify({ at: new Date().toISOString() });
  await project.connect(ADA, connection);
  assert.equal(project.kv[`own-google/removed/${connection}`], undefined);
  await project.publish(9);
  assert.ok(project.kv[`own-google/accounts/${connection}`]);
  assert.deepEqual(
    project
      .registry()
      .filter((event) => event.payload.connection === connection)
      .at(-1)!.payload.row,
    row(),
  );
});

// --------------------------------------------------------------- disconnect

test("Disconnect deletes the account's secret and kv entry, takes its row away and registers the card; the access stays granted at Google", async () => {
  const { project, connection } = await connected();
  const before = project.registry().length;
  const res = await project.page("/disconnect", { form: { id: connection } });
  assert.equal(res.headers.get("location"), "./");
  assert.equal(project.secrets[`/secrets/own-google-${connection}`], undefined);
  assert.ok(project.secrets["/secrets/own-google-app"], "the client's secret stays");
  assert.equal(project.kv[`own-google/accounts/${connection}`], undefined);
  assert.deepEqual(project.registry().slice(before), [
    { type: CONNECTION_CONFIGURED, payload: { integration: "google", connection, row: null } },
    { type: CONFIGURED, payload: { integration: "google", card: NO_ACCOUNT } },
  ]);
  const html = await (await project.page("/")).text();
  assert.match(html, /The access stays granted at Google/);
  assert.match(html, /None yet/);
  // an unknown one changes nothing
  for (const id of ["ffffffff", "not-a-connection"])
    assert.match(
      location(await project.page("/disconnect", { form: { id } })),
      /error=Unknown account/,
    );
});

test("a Disconnect whose secret cannot be deleted says so, and keeps the account and its row for another try", async () => {
  const { project, connection } = await connected();
  const before = project.registry().length;
  project.faults.deletes = true;
  const res = await project.page("/disconnect", { form: { id: connection } });
  assert.match(location(res), /error=the secret store is unavailable/);
  assert.ok(project.secrets[`/secrets/own-google-${connection}`], "the tokens stay, and say so");
  assert.ok(project.kv[`own-google/accounts/${connection}`]);
  assert.equal(project.kv[`own-google/removed/${connection}`], undefined);
  assert.equal(project.registry().length, before, "no row is taken away");
  project.faults.deletes = false;
  assert.equal(
    (await project.page("/disconnect", { form: { id: connection } })).headers.get("location"),
    "./",
  );
  assert.equal(project.secrets[`/secrets/own-google-${connection}`], undefined);
  assert.equal(project.kv[`own-google/accounts/${connection}`], undefined);
});

test("a Disconnect whose secret is already gone finishes", async () => {
  const { project, connection } = await connected();
  delete project.secrets[`/secrets/own-google-${connection}`];
  const res = await project.page("/disconnect", { form: { id: connection } });
  assert.equal(res.headers.get("location"), "./");
  assert.equal(project.kv[`own-google/accounts/${connection}`], undefined);
  assert.equal(project.registry().at(-2)!.payload.row, null);
});

test("a Disconnect whose row cannot be taken away leaves a tombstone: Disconnect again, or the next publish, finishes it", async () => {
  for (const finish of ["disconnect", "publish"] as const) {
    const { project, connection } = await connected();
    project.faults.registry = 1;
    const failed = await project.page("/disconnect", { form: { id: connection } });
    assert.match(location(failed), /error=the registry is unavailable/, finish);
    assert.equal(project.secrets[`/secrets/own-google-${connection}`], undefined);
    assert.equal(project.kv[`own-google/accounts/${connection}`], undefined);
    assert.ok(
      project.kv[`own-google/removed/${connection}`],
      "the tombstone stands until the null row lands",
    );
    assert.ok(!project.registry().some((event) => event.payload.row === null));
    if (finish === "disconnect") {
      const again = await project.page("/disconnect", { form: { id: connection } });
      assert.equal(again.headers.get("location"), "./", "not Unknown account");
      assert.deepEqual(project.registry().at(-2), {
        type: CONNECTION_CONFIGURED,
        payload: { integration: "google", connection, row: null },
      });
    } else {
      await project.publish(9);
      assert.deepEqual(
        project
          .registry()
          .filter((event) => event.payload.connection === connection)
          .at(-1),
        {
          type: CONNECTION_CONFIGURED,
          idempotencyKey: `google:registry:removed:${connection}:/@9`,
          payload: { integration: "google", connection, row: null },
        },
      );
    }
    assert.equal(project.kv[`own-google/removed/${connection}`], undefined, finish);
  }
});

// --------------------------------------------- the Dash's Integrations page

test("the install hook registers the card and a row per account, keyed by the event's path and offset: a retry appends nothing new", async () => {
  const project = fakeProject();
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "google:registry:/@5",
      payload: { integration: "google", card: NO_CLIENT },
    },
  ]);

  await project.setUp();
  await project.connect(ADA);
  const connection = project.lastConnection();
  await project.publish(5); // the same event again, now set up: its key is spent, and that is fine
  const before = project.registry().length;
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(9);
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONFIGURED,
      idempotencyKey: "google:registry:/@9",
      payload: { integration: "google", card: READY },
    },
    {
      type: CONNECTION_CONFIGURED,
      idempotencyKey: `google:registry:${connection}:/@9`,
      payload: { integration: "google", connection, row: row() },
    },
  ]);
});

test("the card asks for the client, then for an account, then is ok", async () => {
  const project = fakeProject();
  const cardAt = async (offset: number) => {
    await project.publish(offset);
    return project.registry().at(-1)!.payload.card;
  };
  assert.deepEqual(await cardAt(1), NO_CLIENT);
  project.secrets["/secrets/own-google-app"] = structuredClone(SECRET_ALONE);
  assert.deepEqual(
    await cardAt(2),
    NO_CLIENT,
    "the secret without its public client ID is no client",
  );
  await project.setUp();
  assert.deepEqual(await cardAt(3), NO_ACCOUNT);
  await project.connect(ADA);
  await project.publish(4);
  assert.deepEqual(
    project.registry().find((event) => event.idempotencyKey === "google:registry:/@4")!.payload
      .card,
    READY,
  );
});

test("the Dash's buttons lead to the slug it answers on; the hook ignores every other event", async () => {
  const project = fakeProject({ slug: "gmail" });
  await project.publish(1);
  assert.deepEqual(
    project.registry()[0]!.payload.card,
    card(
      { kind: "attention", text: "Create an OAuth client and paste its secret" },
      "Connect",
      "gmail",
    ),
  );
  await project.setUp();
  await project.start();
  assert.deepEqual(project.begun[0]!.options.redirect, {
    routingSlug: "gmail",
    path: "/oauth2/callback",
  });
  const count = project.appended.length;
  for (const event of [
    // another secret's fact, the client's own on its secret's path, and a fact with no payload
    { type: "events.iterate.com/secret/set", path: "/", payload: { path: "/secrets/other" } },
    {
      type: "events.iterate.com/secret/set",
      path: "/secrets/own-google-app",
      payload: { path: "/secrets/own-google-app" },
    },
    { type: "events.iterate.com/secret/deleted", path: "/" },
    { type: "events.iterate.com/integration/configured", path: "/integrations" },
  ])
    await project.integration.processEvent!({ event: { ...event, offset: 2 }, itx: project.itx });
  assert.equal(project.appended.length, count);
});

test("the client saved or deleted on the Dash registers the card again, keyed by its secret's fact on /: a retry appends nothing new", async () => {
  const project = fakeProject();
  const fact = (type: string, offset: number, payload: object) =>
    project.integration.processEvent!({
      event: { type, path: "/", offset, payload },
      itx: project.itx,
    });
  await project.setUp();
  for (let attempt = 0; attempt < 2; attempt++)
    await fact("events.iterate.com/secret/set", 7, {
      path: "/secrets/own-google-app",
      urls: ["https://oauth2.googleapis.com"],
      public: { clientId: CLIENT_ID },
    });
  delete project.secrets["/secrets/own-google-app"];
  await fact("events.iterate.com/secret/deleted", 8, { path: "/secrets/own-google-app" });
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "google:registry:/@7",
      payload: { integration: "google", card: NO_ACCOUNT },
    },
    {
      type: CONFIGURED,
      idempotencyKey: "google:registry:/@8",
      payload: { integration: "google", card: NO_CLIENT },
    },
  ]);
});

test("a long address and many scopes are cut to the registry's limits", async () => {
  const long = { id: "1003", email: `${"a".repeat(240)}@example.com` };
  const project = fakeProject({
    scopes: Array.from(
      { length: 12 },
      (_, at) => `https://www.googleapis.com/auth/scope-${at}.readonly`,
    ),
  });
  await project.setUp();
  await project.connect(long);
  const { row: registered } = project.registry().at(-1)!.payload;
  assert.equal(registered.account.length, 200);
  assert.ok(registered.account.endsWith("…"));
  assert.equal(registered.details.Scopes.length, 200);
  assert.ok(
    registered.details.Scopes.startsWith("openid userinfo.email userinfo.profile scope-0.readonly"),
  );
});

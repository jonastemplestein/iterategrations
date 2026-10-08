// Runs against dist, the package as shipped. `fakeProject` is a project: secrets (a catalog that
// answers the public fields a set named and never a secret one, an HMAC check run here as the
// platform's is, a delete of a missing secret refused as SECRET_NOT_SET, and a collection link to a
// pretend Dash), a kv, appends that refuse a key used twice for another event (as the platform
// does; the same event again is a no-op), and an egress to a pretend GitHub that records every
// request. The egress mints an installation's token as the platform does: on first use, while its
// secret and the App's exist, and only for the App's real ID. `faults` makes a secret's delete or
// an append on /integrations fail. `host` is the worker hosting the package: a scope per `getItx`,
// counted.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vite-plus/test";
import { github } from "../dist/github.js";

const ORIGIN = "https://github--iterate.example";
const WEBHOOK_SECRET = "a-made-up-webhook-secret";
const PIN = ["https://github.com", "https://api.github.com"];
/** The App's real ID at the pretend GitHub: a token is minted for no other. */
const APP_ID = "123456";
/** The App as the Dash's form saves it: one secret, its ID and slug public fields beside its key and
 *  its webhook secret. */
const APP_SECRET = {
  material: {
    appId: APP_ID,
    slug: "iterate-acme",
    privateKey: "-----BEGIN A FAKE KEY-----",
    webhookSecret: WEBHOOK_SECRET,
  },
  options: { urls: PIN, public: ["appId", "slug"] },
};
/** The key and the webhook secret alone, with no public App ID and slug: set by hand, or saved by the
 *  package before it asked for them on the same form. */
const SECRETS_ALONE = {
  material: { privateKey: "-----BEGIN A FAKE KEY-----", webhookSecret: WEBHOOK_SECRET },
  options: { urls: PIN },
};
const CONFIGURED = "events.iterate.com/integration/configured";
const CONNECTION_CONFIGURED = "events.iterate.com/integration/connection-configured";
const DASH_LINK = "https://dash.example/collect-secret/iterate?path=%2Fsecrets%2Fown-github-app";
const APP_ID_PATTERN = String.raw`\d{1,12}`;
const SLUG_PATTERN = String.raw`[a-z0-9][a-z0-9\-]{0,99}`;

type Call = { url: string; headers: Record<string, string> };

function fakeProject(options: { slug?: string } = {}) {
  const secrets: Record<string, { material: any; options: any }> = {};
  const kv: Record<string, string> = {};
  const appended: { path: string; event: any }[] = [];
  const calls: Call[] = [];
  const collected: any[] = [];
  const scopes = { opened: 0, disposed: 0 };
  // GitHub refuses the proof with `refuse`; `accounts` names an installation's account
  const github_ = { refuse: 0, accounts: {} as Record<string, string>, mints: 0 };
  const faults = { deletes: false, registry: 0 };
  /** Every secret path and kv key ever written, for the names test. */
  const written = { secrets: new Set<string>(), kv: new Set<string>() };
  const itx: any = {
    secrets: {
      set: async (path: string, material: unknown, options: unknown) => {
        written.secrets.add(path);
        secrets[path] = structuredClone({ material, options });
      },
      delete: async (path: string) => {
        if (faults.deletes)
          throw Object.assign(new Error("the secret store is unavailable"), {
            code: "UNAVAILABLE",
          });
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
      verifyHmac: async (
        path: string,
        input: { payload: string; signature: string; field?: string },
      ) => {
        const key = input.field ? secrets[path]?.material?.[input.field] : secrets[path]?.material;
        return (
          typeof key === "string" &&
          createHmac("sha256", key).update(input.payload).digest("hex") ===
            input.signature.toLowerCase()
        );
      },
      collectFromUser: async (input: { path: string }) => {
        collected.push(input);
        return { path: input.path, url: DASH_LINK };
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
    fetch: async (request: Request) => {
      calls.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      const path =
        /^Bearer getSecret\("(\/secrets\/own-github-[^"]+)", \{ field: "accessToken" \}\)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
      const secret = path ? secrets[path] : undefined;
      if (!secret || !secrets["/secrets/own-github-app"])
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      // the platform mints the installation's token on first use, from the App ID and the App's key
      if (!secret.material.accessToken) {
        if (secret.material.appId !== APP_ID)
          return Response.json({ message: "Integration not found" }, { status: 401 });
        secret.material.accessToken = `a-made-up-token-${++github_.mints}`;
      }
      if (github_.refuse)
        return Response.json({ message: "Not Found" }, { status: github_.refuse });
      if (new URL(request.url).pathname === "/installation/repositories") {
        const login = github_.accounts[secret.options.refresh.installationId] ?? "acme";
        return Response.json({
          total_count: 3,
          repositories: [{ full_name: `${login}/pets`, owner: { login } }],
        });
      }
      return new Response("unexpected", { status: 500 });
    },
  };
  const integration = github(options.slug ? { slug: options.slug } : {});
  const serve = (request: Request, requireMember: (r: Request) => Response | null = () => null) =>
    integration.fetch!(request, {
      getItx: () => {
        scopes.opened++;
        return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
      },
      auth: { require: requireMember },
    });
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
  /** The App made at GitHub, and saved on the Dash's one form: its ID and slug public, beside its
   *  key and its webhook secret. */
  const setUp = async () => {
    secrets["/secrets/own-github-app"] = structuredClone(APP_SECRET);
  };
  /** Press Install: the nonce in the link to GitHub. */
  const install = async () => {
    const res = await page("/install", { form: {} });
    return new URL(res.headers.get("location")!).searchParams.get("state")!;
  };
  /** GitHub's redirect to the setup URL. */
  const callback = (query: Record<string, string>) =>
    page(`/oauth2/callback?${new URLSearchParams(query).toString()}`);
  /** A delivery as GitHub sends it, signed with `secret`. */
  const deliver = (
    body: unknown,
    options: { secret?: string | null; delivery?: string; event?: string } = {},
  ) => {
    const raw = JSON.stringify(body);
    const secret = options.secret === undefined ? WEBHOOK_SECRET : options.secret;
    return serve(
      new Request(`${ORIGIN}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": options.delivery ?? "72d3162e-cc78-11e3-81ab-4c9367dc0958",
          "x-github-event": options.event ?? "issues",
          ...(secret === null
            ? {}
            : {
                "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
              }),
        },
        body: raw,
      }),
    );
  };
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
    calls,
    collected,
    scopes,
    faults,
    written,
    github: github_,
    serve,
    page,
    setUp,
    install,
    callback,
    deliver,
    publish,
    registry,
  };
}

const location = (res: Response) => decodeURIComponent(res.headers.get("location") ?? "");
const card = (status: object, label: string, routingSlug = "github") => ({
  title: "GitHub",
  description:
    "The project's own GitHub App: each installation's webhook deliveries as events, and GitHub's API as the installation, with tokens the platform mints.",
  status,
  actions: [{ label, routingSlug, path: "/" }],
});
const row = (routingSlug = "github") => ({
  account: "acme",
  status: { kind: "ok" },
  actions: [
    { label: "Manage", routingSlug, path: "/" },
    { label: "Open", url: "https://github.com/acme" },
  ],
  details: { Installation: "42" },
});
const READY = card({ kind: "ok" }, "Manage");
const NOT_READY = card(
  { kind: "attention", text: "Create a GitHub App and paste its secrets" },
  "Connect",
);

/** A project with installation 42 connected through the page. */
async function connected() {
  const project = fakeProject();
  await project.setUp();
  await project.callback({
    installation_id: "42",
    setup_action: "install",
    state: await project.install(),
  });
  return project;
}

// ------------------------------------------------------------- the integration

test("every name the package keeps is its own: no secret, stream or kv key the platform's shared GitHub App could own", async () => {
  const project = await connected();
  await project.deliver({ action: "opened", installation: { id: 42 } });
  await project.callback({ setup_action: "request", state: await project.install() });
  await project.callback({
    installation_id: "42",
    setup_action: "update",
    state: await project.install(),
  });
  project.faults.registry = 1; // leaves a tombstone behind, for a while
  await project.page("/disconnect", { form: { id: "42" } });
  await project.publish(3);
  // the App's own secret is the Dash's to write; the package writes the proof's and the installation's
  assert.deepEqual([...project.written.secrets].sort(), [
    "/secrets/own-github-42",
    "/secrets/own-github-42-proof",
  ]);
  assert.ok(project.written.kv.size >= 5, [...project.written.kv].join(" "));
  for (const path of project.written.secrets) assert.match(path, /^\/secrets\/own-github-/);
  for (const key of project.written.kv) assert.match(key, /^own-github\//);
  for (const { path } of project.appended)
    assert.match(path, /^\/integrations(\/own-github(\/\d+)?)?$/, path);
});

test("it answers its own routing slug, github unless another is given; anything but its page, callback and webhook is a 404", async () => {
  assert.equal(github().routingSlug, "github");
  assert.equal(github({ slug: "gh" }).routingSlug, "gh");
  const project = fakeProject();
  for (const path of ["/nope", "/oauth2/callbacks", "/webhook/x"])
    assert.equal((await project.page(path)).status, 404, path);
  // a member's stray path opens the project's scope and releases it, and writes nothing
  assert.equal(project.scopes.opened, project.scopes.disposed);
  assert.deepEqual(project.kv, {});
});

test("the page and the callback are for members: whatever auth.require answers is sent, and nothing is read or written", async () => {
  const project = fakeProject();
  const refused = () => new Response("Sign in\n", { status: 401 });
  for (const [path, form] of [
    ["/", undefined],
    ["/install", {}],
    ["/connect", { id: "42" }],
    ["/oauth2/callback?installation_id=42&setup_action=install&state=x", undefined],
  ] as const)
    assert.equal((await project.page(path, { form }, refused)).status, 401, path);
  assert.deepEqual(project.kv, {});
  assert.deepEqual(project.secrets, {});
  assert.deepEqual(project.calls, []);
  assert.equal(project.scopes.opened, 0);
});

test("each request opens one scope and releases it; the webhook asks for no member", async () => {
  const project = fakeProject();
  await project.page("/");
  await project.deliver({ zen: "Keep it logically awesome." }, { event: "ping" });
  assert.deepEqual(project.scopes, { opened: 2, disposed: 2 });
});

// ------------------------------------------------------------------- the page

test("the page shows the URLs to paste at GitHub, from the request's origin and the base path a paths ingress strips, each with a Copy button", async () => {
  const project = fakeProject();
  const res = await project.page("/", {
    headers: { "x-iterate-base-path": "/projects/iterate" },
  });
  const html = await res.text();
  assert.equal(res.status, 200);
  for (const url of [
    `${ORIGIN}/projects/iterate/`,
    `${ORIGIN}/projects/iterate/oauth2/callback`,
    `${ORIGIN}/projects/iterate/webhook`,
  ])
    assert.ok(html.includes(`data-copy="${url}"`), url);
  assert.match(html, /Redirect on update/);
  assert.match(html, /https:\/\/github\.com\/settings\/apps\/new/);
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /form-action 'self' https:\/\/github\.com;/);
  // no other site may frame it: a framed Disconnect would post from this origin
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
  assert.equal(html.match(/<script/g)!.length, 1);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.doesNotMatch(html, /onclick=/);
});

test("the page links to the Dash's one form for the App, its ID and slug public beside its secrets, which never pass through this code; the form checks the ID's and the slug's shapes as the browser does", async () => {
  const project = fakeProject();
  const html = await (await project.page("/")).text();
  assert.ok(html.includes(`href="${DASH_LINK.replace(/&/g, "&amp;")}"`));
  assert.match(html, />Save the App</);
  assert.match(project.collected[0]!.description, /BEGIN and END lines/);
  assert.deepEqual(
    project.collected.map((input) => ({ ...input, description: undefined })),
    [
      {
        path: "/secrets/own-github-app",
        egress: { urls: PIN },
        description: undefined,
        fields: [
          {
            name: "appId",
            label: "App ID",
            public: true,
            placeholder: "123456",
            pattern: APP_ID_PATTERN,
          },
          {
            name: "slug",
            label: "Slug: the end of github.com/apps/<slug>",
            public: true,
            pattern: SLUG_PATTERN,
          },
          { name: "privateKey", label: "Private key (.pem)", multiline: true },
          { name: "webhookSecret", label: "Webhook secret" },
        ],
      },
    ],
  );
  // HTML's pattern takes the whole value, compiled with the `v` flag
  const shape = (pattern: string) => new RegExp(`^(?:${pattern})$`, "v");
  assert.match(APP_ID, shape(APP_ID_PATTERN));
  for (const value of ["abc", "", "1234567890123"])
    assert.doesNotMatch(value, shape(APP_ID_PATTERN));
  assert.match("iterate-acme", shape(SLUG_PATTERN));
  for (const value of ["Not A Slug", "-acme", "https://github.com/apps/iterate-acme"])
    assert.doesNotMatch(value, shape(SLUG_PATTERN));
  await project.setUp();
  assert.match(await (await project.page("/")).text(), />Replace it</);
});

test("the App is read from the catalog's public fields: the page shows its ID and link, Install leads to it, and the kv keeps no copy", async () => {
  const project = fakeProject();
  await project.setUp();
  const html = await (await project.page("/")).text();
  assert.match(html, /App 123456/);
  assert.match(html, /href="https:\/\/github\.com\/apps\/iterate-acme"/);
  assert.doesNotMatch(html, /has no public App ID/);
  const to = new URL((await project.page("/install", { form: {} })).headers.get("location")!);
  assert.equal(to.origin + to.pathname, "https://github.com/apps/iterate-acme/installations/new");
  await project.callback({
    installation_id: "42",
    setup_action: "install",
    state: to.searchParams.get("state")!,
  });
  assert.equal(project.secrets["/secrets/own-github-42"]!.material.appId, APP_ID);
  assert.ok(!Object.values(project.kv).some((value) => value.includes("iterate-acme")));
});

test("a secret without the public fields is not set up: the page asks to save the App again, and Install is refused", async () => {
  const project = fakeProject();
  project.secrets["/secrets/own-github-app"] = structuredClone(SECRETS_ALONE);
  const html = await (await project.page("/")).text();
  assert.match(html, /has no public App ID and slug\. Save the App again/);
  assert.match(html, />Save the App</);
  assert.doesNotMatch(html, /action="install"/);
  assert.match(location(await project.page("/install", { form: {} })), /error=Save the App first/);
  assert.deepEqual(
    Object.keys(project.kv).filter((key) => key.startsWith("own-github/pending/")),
    [],
  );
});

test("Install needs the App; then it sends the person to GitHub with a nonce good for an hour", async () => {
  const project = fakeProject();
  assert.match(location(await project.page("/install", { form: {} })), /error=Save the App first/);
  assert.deepEqual(
    Object.keys(project.kv).filter((key) => key.startsWith("own-github/pending/")),
    [],
  );
  await project.setUp();
  const res = await project.page("/install", { form: {} });
  assert.equal(res.status, 303);
  const to = new URL(res.headers.get("location")!);
  assert.equal(to.origin + to.pathname, "https://github.com/apps/iterate-acme/installations/new");
  const nonce = to.searchParams.get("state")!;
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const at = JSON.parse(project.kv[`own-github/pending/${nonce}`]!).at;
  assert.ok(Math.abs(Date.now() - at) < 5000);
  assert.match(await (await project.page("/")).text(), /<form method="post" action="install">/);
});

test("no other site can frame the page's answers or the callback's", async () => {
  const project = fakeProject();
  await project.setUp();
  const answers = [
    await project.page("/connect", { form: { id: "7" } }),
    await project.page("/disconnect", { form: { id: "7" } }),
    await project.callback({ installation_id: "42", setup_action: "install", state: "x" }),
    await project.callback({
      installation_id: "42",
      setup_action: "install",
      state: await project.install(),
    }),
  ];
  for (const res of answers) {
    assert.equal(res.headers.get("x-frame-options"), "DENY", res.headers.get("location")!);
    assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  }
});

// --------------------------------------------------------------- the callback

test("the callback for an install sets the installation's secret, proves it with one call, lists it, registers its row and the card, and sends the person back", async () => {
  const project = fakeProject();
  await project.setUp();
  const nonce = await project.install();
  const before = project.registry().length;
  const res = await project.callback({
    installation_id: "42",
    setup_action: "install",
    state: nonce,
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "../?connected=acme");
  // the App ID and the key's placeholder, which the platform resolves at each mint
  assert.deepEqual(project.secrets["/secrets/own-github-42"], {
    material: {
      appId: "123456",
      privateKey: 'getSecret("/secrets/own-github-app", { field: "privateKey" })',
    },
    options: {
      urls: PIN,
      refresh: {
        kind: "github-app-installation",
        apiOrigin: "https://api.github.com",
        installationId: "42",
        client: { project: "github" },
      },
    },
  });
  // proved through a secret of its own, which is gone again
  assert.deepEqual(project.calls, [
    {
      url: "https://api.github.com/installation/repositories?per_page=1",
      headers: {
        accept: "application/vnd.github+json",
        authorization: 'Bearer getSecret("/secrets/own-github-42-proof", { field: "accessToken" })',
        "user-agent": "iterate",
      },
    },
  ]);
  assert.equal(project.secrets["/secrets/own-github-42-proof"], undefined);
  assert.equal(JSON.parse(project.kv["own-github/installations/42"]!).account, "acme");
  // the nonce is claimed once, in the log: kv cannot claim anything
  const claims = project.appended.filter((a) => a.event.type === "own-github/nonce-used");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.path, "/integrations/own-github");
  assert.equal(claims[0]!.event.idempotencyKey, `own-github:nonce:${nonce}`);
  assert.equal(claims[0]!.event.payload.nonce, nonce);
  // the card first: a row stands under its card alone
  assert.deepEqual(project.registry().slice(before), [
    { type: CONFIGURED, payload: { integration: "github", card: READY } },
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "github", connection: "42", row: row() },
    },
  ]);
  const html = await (await project.page("/?connected=acme")).text();
  assert.match(html, /Installed on acme/);
  assert.match(html, /<b>acme<\/b> <span class="muted">installation 42/);
});

test("the callback for an update does the same; a nonce is good once, and a missing, unknown or expired one is refused and sets nothing", async () => {
  const project = fakeProject();
  await project.setUp();
  const nonce = await project.install();
  const updated = await project.callback({
    installation_id: "42",
    setup_action: "update",
    state: nonce,
  });
  assert.equal(updated.headers.get("location"), "../?connected=acme");
  delete project.secrets["/secrets/own-github-42"];
  delete project.kv["own-github/installations/42"];

  const expired = await project.install();
  project.kv[`own-github/pending/${expired}`] = JSON.stringify({ at: Date.now() - 61 * 60 * 1000 });
  for (const state of [nonce, "", "0".repeat(32), "not-a-nonce", expired]) {
    const res = await project.callback({ installation_id: "42", setup_action: "install", state });
    assert.match(
      location(res),
      /error=GitHub came back from an install this page did not start/,
      state,
    );
  }
  assert.equal(
    (await project.callback({ installation_id: "42", setup_action: "install" })).status,
    303,
  );
  assert.equal(project.secrets["/secrets/own-github-42"], undefined);
  assert.equal(project.kv["own-github/installations/42"], undefined);
});

test("two callbacks with one nonce, started together: exactly one goes on, and the other writes nothing", async () => {
  const project = fakeProject();
  await project.setUp();
  const nonce = await project.install();
  const answers = await Promise.all(
    [0, 1].map(() =>
      project.callback({ installation_id: "42", setup_action: "install", state: nonce }),
    ),
  );
  const flashes = answers.map(location).sort();
  assert.equal(flashes.filter((flash) => flash.endsWith("?connected=acme")).length, 1, flashes[0]);
  assert.equal(flashes.filter((flash) => flash.includes("?error=")).length, 1, flashes[1]);
  assert.equal(project.calls.length, 1, "one proof");
  assert.equal(project.secrets["/secrets/own-github-42"]!.material.appId, APP_ID);
  assert.ok(project.kv["own-github/installations/42"]);
  assert.equal(project.appended.filter((a) => a.event.type === "own-github/nonce-used").length, 1);
});

test("the callback for a request records a row that waits for an owner's approval; the installation that follows replaces it", async () => {
  const project = fakeProject();
  await project.setUp();
  const nonce = await project.install();
  const res = await project.callback({ setup_action: "request", state: nonce });
  assert.equal(res.headers.get("location"), "../?requested=1");
  const connection = `request-${nonce.slice(0, 16)}`;
  assert.equal(JSON.parse(project.kv[`own-github/installations/${connection}`]!).requested, true);
  assert.deepEqual(Object.keys(project.secrets), ["/secrets/own-github-app"]);
  const requested = project.registry().at(-1)!;
  assert.equal(requested.payload.connection, connection);
  assert.equal(requested.payload.row.account, "An installation request");
  assert.deepEqual(requested.payload.row.status, {
    kind: "attention",
    text: "Awaiting an owner's approval",
  });
  assert.match(await (await project.page("/?requested=1")).text(), /awaiting an owner's approval/);

  // the owner approves it, and GitHub comes back with the request's own nonce, after the hour too
  const removed = (connection: string) =>
    project
      .registry()
      .some((event) => event.payload.connection === connection && event.payload.row === null);
  project.github.accounts["77"] = "acme-org";
  const approved = await project.callback({
    installation_id: "77",
    setup_action: "install",
    state: nonce,
  });
  assert.equal(approved.headers.get("location"), "../?connected=acme-org");
  assert.equal(project.kv[`own-github/installations/${connection}`], undefined);
  assert.ok(removed(connection));
  assert.equal(JSON.parse(project.kv["own-github/installations/77"]!).account, "acme-org");
  // and the request's nonce is spent with it
  const again = await project.callback({ setup_action: "request", state: nonce });
  assert.match(location(again), /error=GitHub came back from an install this page did not start/);
});

test("an install answers only the request whose nonce came back with it: the others wait, for their approval or for Forget", async () => {
  const project = fakeProject();
  await project.setUp();
  const requested: string[] = [];
  for (const _org of ["a", "b"]) {
    const nonce = await project.install();
    await project.callback({ setup_action: "request", state: nonce });
    requested.push(nonce);
  }
  const waiting = () =>
    Object.keys(project.kv)
      .filter((key) => key.startsWith("own-github/installations/request-"))
      .sort();
  const both = requested.map((nonce) => `own-github/installations/request-${nonce.slice(0, 16)}`);
  assert.deepEqual(waiting(), [...both].sort());

  // an installation no request asked for leaves both waiting
  await project.callback({
    installation_id: "42",
    setup_action: "install",
    state: await project.install(),
  });
  assert.deepEqual(waiting(), [...both].sort());
  assert.ok(!project.registry().some((event) => event.payload.row === null));

  // the approval of the first takes its row; the second waits
  project.github.accounts["77"] = "org-a";
  await project.callback({ installation_id: "77", setup_action: "install", state: requested[0]! });
  assert.deepEqual(waiting(), [both[1]]);
  const nulls = project.registry().filter((event) => event.payload.row === null);
  assert.deepEqual(
    nulls.map((event) => event.payload.connection),
    [`request-${requested[0]!.slice(0, 16)}`],
  );
  // Forget takes the second away by hand
  await project.page("/disconnect", { form: { id: `request-${requested[1]!.slice(0, 16)}` } });
  assert.deepEqual(waiting(), []);
});

test("a proof GitHub refuses deletes the secret again, shows the error, and lists nothing", async () => {
  const project = fakeProject();
  await project.setUp();
  project.github.refuse = 404;
  const before = project.registry().length;
  const res = await project.callback({
    installation_id: "42",
    setup_action: "install",
    state: await project.install(),
  });
  assert.match(location(res), /error=GitHub refused installation 42 \(HTTP 404: Not Found\)/);
  assert.equal(project.secrets["/secrets/own-github-42"], undefined);
  assert.equal(project.secrets["/secrets/own-github-42-proof"], undefined);
  assert.equal(project.kv["own-github/installations/42"], undefined);
  assert.equal(project.registry().length, before);
  const html = await (await project.page(`/${res.headers.get("location")!.slice(3)}`)).text();
  assert.match(html, /class="error">GitHub refused installation 42/);
});

test("an update whose proof fails leaves the installation as it was: its App ID and its minted token", async () => {
  const project = await connected();
  // the installation is in use: the platform has minted its token
  await project.itx.fetch(
    new Request("https://api.github.com/installation/repositories", {
      headers: {
        authorization: 'Bearer getSecret("/secrets/own-github-42", { field: "accessToken" })',
      },
    }),
  );
  const kept = structuredClone(project.secrets["/secrets/own-github-42"]);
  assert.match(kept!.material.accessToken, /^a-made-up-token-/);

  // GitHub is down, then a wrong App ID is saved: both updates fail, and neither touches it
  project.github.refuse = 502;
  const down = await project.callback({
    installation_id: "42",
    setup_action: "update",
    state: await project.install(),
  });
  assert.match(location(down), /error=GitHub refused installation 42 \(HTTP 502/);
  project.github.refuse = 0;
  project.secrets["/secrets/own-github-app"] = structuredClone(APP_SECRET);
  project.secrets["/secrets/own-github-app"].material.appId = "999999";
  const wrong = await project.callback({
    installation_id: "42",
    setup_action: "update",
    state: await project.install(),
  });
  assert.match(location(wrong), /error=GitHub refused installation 42 \(HTTP 401/);
  assert.deepEqual(project.secrets["/secrets/own-github-42"], kept);
  assert.equal(project.secrets["/secrets/own-github-42-proof"], undefined);
  assert.equal(JSON.parse(project.kv["own-github/installations/42"]!).account, "acme");
});

test("an update that passes its proof replaces the installation's secret, and the proof's secret goes", async () => {
  const project = await connected();
  await project.itx.fetch(
    new Request("https://api.github.com/installation/repositories", {
      headers: {
        authorization: 'Bearer getSecret("/secrets/own-github-42", { field: "accessToken" })',
      },
    }),
  );
  project.github.accounts["42"] = "acme-renamed";
  const res = await project.callback({
    installation_id: "42",
    setup_action: "update",
    state: await project.install(),
  });
  assert.equal(res.headers.get("location"), "../?connected=acme-renamed");
  // set again from the proof's material: the platform mints a fresh token at the next use
  assert.deepEqual(project.secrets["/secrets/own-github-42"]!.material, {
    appId: APP_ID,
    privateKey: 'getSecret("/secrets/own-github-app", { field: "privateKey" })',
  });
  assert.equal(project.secrets["/secrets/own-github-42-proof"], undefined);
  assert.equal(JSON.parse(project.kv["own-github/installations/42"]!).account, "acme-renamed");
});

test("an existing installation connected by its id is proved and listed; a bad id is refused", async () => {
  const project = fakeProject();
  assert.match(
    location(await project.page("/connect", { form: { id: "77" } })),
    /error=Save the App first/,
  );
  await project.setUp();
  const html = await (await project.page("/")).text();
  assert.ok(html.includes('<form method="post" action="connect" class="block">'));
  assert.ok(html.includes('pattern="\\d{1,20}"'));
  assert.match(html, /github\.com\/settings\/installations\/&lt;id&gt;/);

  // GitHub came back for no install: the installation exists, and the page is given its ID
  project.github.accounts["77"] = "acme-org";
  const before = project.registry().length;
  const res = await project.page("/connect", { form: { id: " 77 " } });
  assert.equal(res.headers.get("location"), "./?connected=acme-org");
  // proved through the App's key, on a secret of its own, before the installation's is set
  assert.deepEqual(
    project.calls.map((call) => call.headers.authorization),
    ['Bearer getSecret("/secrets/own-github-77-proof", { field: "accessToken" })'],
  );
  assert.equal(project.secrets["/secrets/own-github-77-proof"], undefined);
  assert.deepEqual(project.secrets["/secrets/own-github-77"]!.material, {
    appId: APP_ID,
    privateKey: 'getSecret("/secrets/own-github-app", { field: "privateKey" })',
  });
  assert.equal(JSON.parse(project.kv["own-github/installations/77"]!).account, "acme-org");
  // the card first: a row stands under its card alone
  assert.deepEqual(project.registry().slice(before), [
    { type: CONFIGURED, payload: { integration: "github", card: READY } },
    {
      type: CONNECTION_CONFIGURED,
      payload: {
        integration: "github",
        connection: "77",
        row: {
          account: "acme-org",
          status: { kind: "ok" },
          actions: [
            { label: "Manage", routingSlug: "github", path: "/" },
            { label: "Open", url: "https://github.com/acme-org" },
          ],
          details: { Installation: "77" },
        },
      },
    },
  ]);
  // its deliveries land now
  await project.deliver({ action: "opened", installation: { id: 77 } });
  assert.ok(project.appended.some((a) => a.path === "/integrations/own-github/77"));

  // a bad ID, and one GitHub refuses (another App's installation), write nothing
  const kv = structuredClone(project.kv);
  const registered = project.registry().length;
  for (const id of ["", "abc", "12 34", "1".repeat(21), "../42"])
    assert.match(
      location(await project.page("/connect", { form: { id } })),
      /error=The installation ID is a number/,
      id,
    );
  project.github.refuse = 404;
  assert.match(
    location(await project.page("/connect", { form: { id: "78" } })),
    /error=GitHub refused installation 78 \(HTTP 404/,
  );
  assert.equal(project.secrets["/secrets/own-github-78"], undefined);
  assert.equal(project.secrets["/secrets/own-github-78-proof"], undefined);
  assert.deepEqual(project.kv, kv);
  assert.equal(project.registry().length, registered);
});

test("Install forgets the nonces of installs that never came back, after an hour", async () => {
  const project = fakeProject();
  await project.setUp();
  const stale = await project.install();
  project.kv[`own-github/pending/${stale}`] = JSON.stringify({ at: Date.now() - 61 * 60 * 1000 });
  const fresh = await project.install();
  const next = await project.install();
  assert.deepEqual(
    Object.keys(project.kv)
      .filter((key) => key.startsWith("own-github/pending/"))
      .sort(),
    [`own-github/pending/${fresh}`, `own-github/pending/${next}`].sort(),
  );
});

// ---------------------------------------------------------------- the webhook

test("a signed delivery lands once on its installation's stream, keyed by its delivery id: a redelivery adds nothing", async () => {
  const project = await connected();
  const body = { action: "opened", installation: { id: 42 }, issue: { number: 7 } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await project.deliver(body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.deepEqual(
    project.appended.filter((a) => a.path.startsWith("/integrations/own-github/")),
    [
      {
        path: "/integrations/own-github/42",
        event: {
          type: "github/delivery-received",
          idempotencyKey: "github:42:72d3162e-cc78-11e3-81ab-4c9367dc0958",
          payload: {
            installationId: "42",
            delivery: { id: "72d3162e-cc78-11e3-81ab-4c9367dc0958", name: "issues" },
            body,
          },
        },
      },
    ],
  );
});

test("an unsigned or wrongly signed delivery is 401 and stores nothing; a GET is 405", async () => {
  const project = await connected();
  const body = { action: "opened", installation: { id: 42 } };
  assert.equal((await project.deliver(body, { secret: null })).status, 401);
  assert.equal((await project.deliver(body, { secret: "another" })).status, 401);
  assert.equal((await project.page("/webhook")).status, 405);
  assert.equal(
    project.appended.filter((a) => a.path.startsWith("/integrations/own-github/")).length,
    0,
  );
  // before the App's secrets are saved, nothing can be checked, so nothing is taken
  const fresh = fakeProject();
  assert.equal((await fresh.deliver(body)).status, 401);
});

test("a delivery for an installation the page did not connect, or for none, is acknowledged and dropped", async () => {
  const project = await connected();
  for (const body of [
    { action: "opened", installation: { id: 7 } },
    { zen: "Speak like a human." },
  ]) {
    const res = await project.deliver(body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "unknown-installation" });
  }
  assert.equal(
    project.appended.filter((a) => a.path.startsWith("/integrations/own-github/")).length,
    0,
  );
});

// --------------------------------------------------------------- disconnect

test("disconnect deletes the installation's secret and kv entry, takes its row away and registers the card; the App stays installed at GitHub", async () => {
  const project = await connected();
  const before = project.registry().length;
  const res = await project.page("/disconnect", { form: { id: "42" } });
  assert.equal(res.headers.get("location"), "./");
  assert.equal(project.secrets["/secrets/own-github-42"], undefined);
  assert.ok(project.secrets["/secrets/own-github-app"], "the App's own secret stays");
  assert.equal(project.kv["own-github/installations/42"], undefined);
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONNECTION_CONFIGURED,
      payload: { integration: "github", connection: "42", row: null },
    },
    { type: CONFIGURED, payload: { integration: "github", card: READY } },
  ]);
  const html = await (await project.page("/")).text();
  assert.match(html, /The App stays installed at GitHub/);
  assert.match(html, /None yet/);
  // a delivery for it is dropped now
  const dropped = await project.deliver({ installation: { id: 42 } });
  assert.deepEqual(await dropped.json(), { ok: true, ignored: "unknown-installation" });
  // and an unknown one changes nothing
  assert.match(
    location(await project.page("/disconnect", { form: { id: "43" } })),
    /Unknown installation/,
  );
});

test("a Disconnect whose secret cannot be deleted says so, and keeps the installation and its row for another try", async () => {
  const project = await connected();
  const before = project.registry().length;
  project.faults.deletes = true;
  const res = await project.page("/disconnect", { form: { id: "42" } });
  assert.match(location(res), /error=the secret store is unavailable/);
  assert.ok(project.secrets["/secrets/own-github-42"], "the token stays, and says so");
  assert.ok(project.kv["own-github/installations/42"]);
  assert.equal(project.kv["own-github/removed/42"], undefined);
  assert.equal(project.registry().length, before, "no row is taken away");
  project.faults.deletes = false;
  assert.equal(
    (await project.page("/disconnect", { form: { id: "42" } })).headers.get("location"),
    "./",
  );
  assert.equal(project.secrets["/secrets/own-github-42"], undefined);
  assert.equal(project.kv["own-github/installations/42"], undefined);
});

test("a Disconnect whose secret is already gone finishes", async () => {
  const project = await connected();
  delete project.secrets["/secrets/own-github-42"];
  const res = await project.page("/disconnect", { form: { id: "42" } });
  assert.equal(res.headers.get("location"), "./");
  assert.equal(project.kv["own-github/installations/42"], undefined);
  assert.equal(project.registry().at(-2)!.payload.row, null);
});

test("a Disconnect whose row cannot be taken away leaves a tombstone: Disconnect again, or the next publish, finishes it", async () => {
  for (const finish of ["disconnect", "publish"] as const) {
    const project = await connected();
    project.faults.registry = 1;
    const failed = await project.page("/disconnect", { form: { id: "42" } });
    assert.match(location(failed), /error=the registry is unavailable/, finish);
    assert.equal(project.secrets["/secrets/own-github-42"], undefined);
    assert.equal(project.kv["own-github/installations/42"], undefined);
    assert.ok(project.kv["own-github/removed/42"], "the tombstone stands until the null row lands");
    assert.ok(!project.registry().some((event) => event.payload.row === null));
    if (finish === "disconnect") {
      const again = await project.page("/disconnect", { form: { id: "42" } });
      assert.equal(again.headers.get("location"), "./", "not Unknown installation");
      assert.deepEqual(project.registry().at(-2), {
        type: CONNECTION_CONFIGURED,
        payload: { integration: "github", connection: "42", row: null },
      });
    } else {
      await project.publish(9);
      assert.deepEqual(
        project
          .registry()
          .filter((event) => event.payload.connection === "42")
          .at(-1),
        {
          type: CONNECTION_CONFIGURED,
          idempotencyKey: "github:registry:removed:42:/@9",
          payload: { integration: "github", connection: "42", row: null },
        },
      );
    }
    assert.equal(project.kv["own-github/removed/42"], undefined, finish);
  }
});

test("an installation connected again after a Disconnect that did not finish keeps its row at the next publish", async () => {
  const project = await connected();
  project.faults.registry = 1;
  await project.page("/disconnect", { form: { id: "42" } });
  assert.ok(project.kv["own-github/removed/42"]);
  await project.callback({
    installation_id: "42",
    setup_action: "install",
    state: await project.install(),
  });
  assert.equal(project.kv["own-github/removed/42"], undefined);
  await project.publish(9);
  assert.deepEqual(
    project
      .registry()
      .filter((event) => event.payload.connection === "42")
      .at(-1)!.payload.row,
    row(),
  );
});

// --------------------------------------------- the Dash's Integrations page

test("the install hook registers the card and a row per installation it knows, keyed by the event's path and offset: a retry appends nothing new", async () => {
  const project = fakeProject();
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "github:registry:/@5",
      payload: { integration: "github", card: NOT_READY },
    },
  ]);

  await project.setUp();
  await project.callback({
    installation_id: "42",
    setup_action: "install",
    state: await project.install(),
  });
  await project.publish(5); // the same event again, now set up: its key is spent, and that is fine
  const before = project.registry().length;
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(9);
  assert.deepEqual(project.registry().slice(before), [
    {
      type: CONFIGURED,
      idempotencyKey: "github:registry:/@9",
      payload: { integration: "github", card: READY },
    },
    {
      type: CONNECTION_CONFIGURED,
      idempotencyKey: "github:registry:42:/@9",
      payload: { integration: "github", connection: "42", row: row() },
    },
  ]);
});

test("the Dash's buttons lead to the slug it answers on; the hook ignores every other event", async () => {
  const project = fakeProject({ slug: "gh" });
  await project.publish(1);
  assert.deepEqual(
    project.registry()[0]!.payload.card,
    card({ kind: "attention", text: "Create a GitHub App and paste its secrets" }, "Connect", "gh"),
  );
  const count = project.appended.length;
  for (const event of [
    { type: "github/delivery-received", path: "/integrations/own-github/42" },
    // another secret's fact, the App's own on its secret's path, and a fact with no payload
    {
      type: "events.iterate.com/secret/set",
      path: "/",
      payload: { path: "/secrets/own-github-42" },
    },
    {
      type: "events.iterate.com/secret/set",
      path: "/secrets/own-github-app",
      payload: { path: "/secrets/own-github-app" },
    },
    { type: "events.iterate.com/secret/deleted", path: "/" },
  ])
    await project.integration.processEvent!({ event: { ...event, offset: 2 }, itx: project.itx });
  assert.equal(project.appended.length, count);
});

test("the App saved or deleted on the Dash registers the card again, keyed by its secret's fact on /: a retry appends nothing new", async () => {
  const project = fakeProject();
  const fact = (type: string, offset: number, payload: object) =>
    project.integration.processEvent!({
      event: { type, path: "/", offset, payload },
      itx: project.itx,
    });
  await project.setUp();
  for (let attempt = 0; attempt < 2; attempt++)
    await fact("events.iterate.com/secret/set", 7, {
      path: "/secrets/own-github-app",
      urls: PIN,
      public: { appId: APP_ID, slug: "iterate-acme" },
    });
  delete project.secrets["/secrets/own-github-app"];
  await fact("events.iterate.com/secret/deleted", 8, { path: "/secrets/own-github-app" });
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "github:registry:/@7",
      payload: { integration: "github", card: READY },
    },
    {
      type: CONFIGURED,
      idempotencyKey: "github:registry:/@8",
      payload: { integration: "github", card: NOT_READY },
    },
  ]);
});

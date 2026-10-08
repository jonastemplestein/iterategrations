// Runs against dist (the package as shipped): `pnpm test` builds first. The package is the Dash's
// card and its page, so this is its install hook and its page against a pretend project.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { jmap } from "../dist/index.js";

const ORIGIN = "https://jmap--iterate.example";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/jmap";

test("jmap() answers the jmap routing slug; its install hook registers the card, keyed by the event's path and offset, ok once the token exists", async () => {
  const appended: { path: string; event: any }[] = [];
  const secrets: string[] = [];
  const itx: any = {
    secrets: { list: async () => secrets.map((path) => ({ path })) },
    cd: (path: string) => ({
      append: async (event: any) => {
        const earlier = appended.find((a) => a.event.idempotencyKey === event.idempotencyKey);
        if (earlier && JSON.stringify(earlier.event) === JSON.stringify(event)) return;
        if (earlier) throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
  };
  const integration = jmap();
  assert.equal(integration.routingSlug, "jmap");
  assert.equal(typeof integration.fetch, "function");
  const publish = (offset: number, type = "events.iterate.com/project/worker-updated") =>
    integration.processEvent!({ event: { type, path: "/", offset }, itx });
  const card = (status: object) => ({
    title: "Mailbox (JMAP)",
    description:
      "The project's own Fastmail mailbox, over JMAP: agents send from it, search it, read whole threads and make Masked Email addresses, calling Fastmail's API with fetch and the token's placeholder.",
    icon: "https://www.google.com/s2/favicons?domain=fastmail.com&sz=64",
    status,
    actions: [
      { label: "Open", routingSlug: "jmap", path: "/" },
      { label: "Recipe", url: RECIPE },
    ],
  });

  for (let attempt = 0; attempt < 2; attempt++) await publish(5);
  secrets.push("/secrets/fastmail");
  await publish(5); // the same event again, now with the token: its key is spent, and that is fine
  await publish(6);
  await publish(7, "events.iterate.com/itx/woken"); // every other event is ignored
  assert.deepEqual(appended, [
    {
      path: "/integrations",
      event: {
        type: "events.iterate.com/integration/configured",
        idempotencyKey: "jmap:registry:/@5",
        payload: {
          integration: "jmap",
          card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
        },
      },
    },
    {
      path: "/integrations",
      event: {
        type: "events.iterate.com/integration/configured",
        idempotencyKey: "jmap:registry:/@6",
        payload: { integration: "jmap", card: card({ kind: "ok" }) },
      },
    },
  ]);
});

// ------------------------------------------------------------------- the page

/** The worker hosting the package, over a project with `secrets`: a scope per `getItx`, counted, and
 *  a member gate that refuses unless `member` is set. */
function hosted(secrets: string[], options: { member?: boolean } = {}) {
  const scopes = { opened: 0, disposed: 0 };
  const integration = jmap();
  const serve = (request: Request) =>
    integration.fetch!(request, {
      getItx: () => {
        scopes.opened++;
        const itx: any = { secrets: { list: async () => secrets.map((path) => ({ path })) } };
        return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
      },
      auth: {
        require: () => (options.member ? null : new Response("Sign in\n", { status: 401 })),
      },
    });
  const page = (path: string) => serve(new Request(`${ORIGIN}${path}`));
  return { scopes, serve, page };
}

test("the page is for members: a non-member gets what auth.require answers, and nothing is read", async () => {
  const project = hosted(["/secrets/fastmail"]);
  for (const path of ["/", "/nope"]) {
    const res = await project.page(path);
    assert.equal(res.status, 401, path);
    assert.equal(await res.text(), "Sign in\n");
  }
  assert.deepEqual(project.scopes, { opened: 0, disposed: 0 });
});

test("the page shows the status: until the token exists, what to paste into a coding agent, with a Copy button", async () => {
  let res = await hosted([], { member: true }).page("/");
  let html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /<h1>Mailbox \(JMAP\)<\/h1>/);
  assert.match(html, /Set up by your coding agent: see the recipe/);
  const hint = `Set up Mailbox (JMAP) in my iterate project. Follow the recipe at ${RECIPE}`;
  assert.ok(html.includes(`data-copy="${hint}"`), hint);
  assert.ok(html.includes(`href="${RECIPE}"`));

  const project = hosted(["/secrets/fastmail"], { member: true });
  res = await project.page("/");
  html = await res.text();
  assert.match(
    html,
    /Set up\. The project has the Fastmail API token <code>\/secrets\/fastmail<\/code>/,
  );
  assert.doesNotMatch(html, /coding agent|data-copy="/);
  assert.deepEqual(project.scopes, { opened: 1, disposed: 1 });
});

test("the page sends a CSP with its one nonce'd script, no form, and no frame, and X-Frame-Options DENY", async () => {
  const res = await hosted([], { member: true }).page("/");
  const html = await res.text();
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
  assert.equal(html.match(/<script/g)!.length, 1);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.doesNotMatch(html, /onclick=|<form/);
});

test("a member's stray path is a 404 that reads nothing", async () => {
  const project = hosted(["/secrets/fastmail"], { member: true });
  for (const path of ["/nope", "/webhook", "/oauth2/callback"])
    assert.equal((await project.page(path)).status, 404, path);
  assert.equal((await project.serve(new Request(`${ORIGIN}/`, { method: "POST" }))).status, 404);
  assert.deepEqual(project.scopes, { opened: 0, disposed: 0 });
});

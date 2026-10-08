// Runs against dist, the package as shipped. `fakeProject` is a project: secrets whose HMAC check
// runs here as the platform's does, files, and streams that refuse a key used twice for another
// event (as the platform does; the same event again is a no-op). `host` is the worker hosting the
// package: a scope per `getItx`, counted, and a member gate that refuses unless `member` is set.
// `signed` is the Pebble app: it signs as its protocol says.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vite-plus/test";
import { pebble } from "../dist/pebble.js";

const SECRET = "a-made-up-signing-secret";
const CONFIGURED = "events.iterate.com/integration/configured";
const ORIGIN = "https://pebble--iterate.example";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/pebble";

function fakeProject(
  secrets: Record<string, string> = { "/secrets/pebble-webhook": SECRET },
  options: { member?: boolean } = {},
) {
  const appended: { path: string; event: any }[] = [];
  const files: Record<string, { contentType?: string; data: Uint8Array }> = {};
  const scopes = { opened: 0, disposed: 0 };
  const itx: any = {
    secrets: {
      list: async () => Object.keys(secrets).map((path) => ({ path })),
      verifyHmac: async (path: string, input: { payload: Uint8Array; signature: string }) =>
        secrets[path] !== undefined &&
        createHmac("sha256", secrets[path]).update(input.payload).digest("hex") ===
          input.signature.replace(/^sha256=/, "").toLowerCase(),
    },
    files: {
      get: (path: string) => ({
        put: async (input: { contentType?: string; data: Uint8Array }) =>
          void (files[path] = input),
      }),
    },
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
  };
  const integration = pebble();
  const host = {
    getItx: () => {
      scopes.opened++;
      return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
    },
    auth: {
      require: () => (options.member ? null : new Response("Sign in\n", { status: 401 })),
    },
  };
  const serve = (request: Request) => integration.fetch!(request, host);
  /** A GET of the package's `path`, as the edge hands it on: `basePath` is what a paths ingress
   *  strips, under the platform's origin. */
  const page = (path: string, basePath?: string) =>
    serve(
      new Request(`${basePath ? "https://os.iterate.example" : ORIGIN}${path}`, {
        headers: basePath ? { "x-iterate-base-path": basePath } : {},
      }),
    );
  /** The platform's `project/worker-updated` on `/`, at `offset`: the install hook. */
  const publish = (offset: number) =>
    integration.processEvent!({
      event: { type: "events.iterate.com/project/worker-updated", path: "/", offset },
      itx,
    });
  const registry = () => appended.filter((a) => a.path === "/integrations").map((a) => a.event);
  return { integration, appended, files, scopes, serve, page, publish, registry, secrets };
}

/** A delivery as the Pebble app makes it: a multipart body, signed over
 *  "v1\n<timestamp>\n<delivery>\n<trigger>\n<0|1>\n" and the raw body. */
async function signed(
  options: {
    test?: boolean;
    secret?: string;
    timestamp?: number;
    version?: string;
    delivery?: string;
  } = {},
): Promise<Request> {
  const form = new FormData();
  form.set("recordedAt", "1760000000000");
  form.set("transcription", "buy oat milk");
  form.set("audio", new File([new Uint8Array([1, 2, 3])], "rec-42.m4a", { type: "audio/mp4" }));
  const draft = new Request("https://pebble--iterate.example/webhook", {
    method: "POST",
    body: form,
  });
  const body = new Uint8Array(await draft.arrayBuffer());
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const delivery = options.delivery ?? "d-1";
  const prefix = `v1\n${timestamp}\n${delivery}\nhold\n${options.test ? "1" : "0"}\n`;
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(Buffer.concat([Buffer.from(prefix), body]))
    .digest("hex");
  return new Request("https://pebble--iterate.example/webhook", {
    method: "POST",
    headers: {
      "content-type": draft.headers.get("content-type")!,
      "x-index-webhook-version": options.version ?? "1",
      "x-index-timestamp": String(timestamp),
      "x-index-delivery": delivery,
      "x-index-trigger": "hold",
      "x-index-test": options.test ? "true" : "false",
      "x-index-signature": signature,
    },
    body,
  });
}

test("it answers the pebble routing slug; a webhook is public, so no member is asked for, and each request opens one scope and releases it", async () => {
  const project = fakeProject();
  assert.equal(project.integration.routingSlug, "pebble");
  assert.equal((await project.serve(await signed())).status, 200);
  assert.equal(
    (await project.serve(new Request("https://pebble--iterate.example/webhook"))).status,
    405,
  );
  assert.deepEqual(project.scopes, { opened: 2, disposed: 2 });
});

test("a signed recording stores its audio as a project file and lands once as pebble/recording-created on /pebble", async () => {
  const project = fakeProject();
  for (let delivery = 0; delivery < 2; delivery++) await project.serve(await signed());
  assert.deepEqual(project.files["/pebble/rec-42.m4a"], {
    contentType: "audio/mp4",
    data: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(project.appended, [
    {
      path: "/pebble",
      event: {
        type: "pebble/recording-created",
        idempotencyKey: "pebble:d-1",
        payload: {
          deliveryId: "d-1",
          trigger: "hold",
          recordedAt: 1760000000000,
          transcript: "buy oat milk",
          audioPath: "/pebble/rec-42.m4a",
        },
      },
    },
  ]);
});

test("a wrong signature or an old timestamp is 401, another protocol version 400, and nothing is stored", async () => {
  const project = fakeProject();
  assert.equal((await project.serve(await signed({ secret: "another" }))).status, 401);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await project.serve(await signed({ timestamp: old }))).status, 401);
  assert.equal((await project.serve(await signed({ version: "2" }))).status, 400);
  assert.equal((await fakeProject({}).serve(await signed())).status, 401); // no secret yet
  assert.deepEqual(project.appended, []);
  assert.deepEqual(project.files, {});
});

test("the app's test event is verified and answered, and stores nothing", async () => {
  const project = fakeProject();
  const res = await project.serve(await signed({ test: true }));
  assert.deepEqual(await res.json(), { ok: true, test: true });
  assert.deepEqual(project.appended, []);
});

// --------------------------------------------- the Dash's Integrations page

const card = (status: object) => ({
  title: "Pebble Index 01",
  description:
    "Every recording made with the ring: the transcript as a pebble/recording-created event on /pebble, the audio as a project file.",
  icon: "https://www.google.com/s2/favicons?domain=repebble.com&sz=64",
  status,
  actions: [
    { label: "Open", routingSlug: "pebble", path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

test("the install hook registers the card, keyed by the event's path and offset: attention until the signing secret exists, ok after", async () => {
  const project = fakeProject({});
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "pebble:registry:/@5",
      payload: {
        integration: "pebble",
        card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
      },
    },
  ]);
  project.secrets["/secrets/pebble-webhook"] = SECRET;
  await project.publish(5); // the same event again, now set up: its key is spent, and that is fine
  await project.publish(6);
  assert.deepEqual(project.registry()[1], {
    type: CONFIGURED,
    idempotencyKey: "pebble:registry:/@6",
    payload: { integration: "pebble", card: card({ kind: "ok" }) },
  });
  assert.equal(project.registry().length, 2);
});

test("the hook ignores every other event", async () => {
  const project = fakeProject();
  await project.integration.processEvent!({
    event: { type: "pebble/recording-created", path: "/pebble", offset: 1 },
    itx: {} as any,
  });
  assert.deepEqual(project.appended, []);
});

// ------------------------------------------------------------------- the page

test("the page is for members: a non-member gets what auth.require answers, and nothing is read", async () => {
  const project = fakeProject();
  for (const path of ["/", "/nope"]) {
    const res = await project.page(path);
    assert.equal(res.status, 401, path);
    assert.equal(await res.text(), "Sign in\n");
  }
  assert.deepEqual(project.scopes, { opened: 0, disposed: 0 });
});

test("the page shows the status and the webhook URL with a Copy button, with the base path a paths ingress strips", async () => {
  const project = fakeProject({}, { member: true });
  let res = await project.page("/");
  let html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /<h1>Pebble Index 01<\/h1>/);
  assert.match(html, /Set up by your coding agent: see the recipe/);
  const hint = `Set up Pebble Index 01 in my iterate project. Follow the recipe at ${RECIPE}`;
  assert.ok(html.includes(`data-copy="${hint}"`), hint);
  assert.ok(html.includes(`data-copy="${ORIGIN}/webhook"`));
  assert.ok(html.includes(`href="${RECIPE}"`));

  project.secrets["/secrets/pebble-webhook"] = SECRET;
  res = await project.page("/", "/projects/iterate/pebble");
  html = await res.text();
  assert.match(
    html,
    /Set up\. The project has the signing secret <code>\/secrets\/pebble-webhook<\/code>/,
  );
  assert.doesNotMatch(html, /coding agent/);
  assert.ok(
    html.includes(`data-copy="https://os.iterate.example/projects/iterate/pebble/webhook"`),
  );
  assert.ok(!html.includes(SECRET));
  assert.deepEqual(project.scopes, { opened: 2, disposed: 2 });
});

test("the page sends a CSP with its one nonce'd script, no form, and no frame, and X-Frame-Options DENY", async () => {
  const res = await fakeProject({}, { member: true }).page("/");
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
  const project = fakeProject({}, { member: true });
  for (const path of ["/nope", "/webhook/x", "/oauth2/callback"])
    assert.equal((await project.page(path)).status, 404, path);
  const post = await project.serve(new Request(`${ORIGIN}/`, { method: "POST" }));
  assert.equal(post.status, 404);
  assert.deepEqual(project.scopes, { opened: 0, disposed: 0 });
});

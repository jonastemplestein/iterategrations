// Runs against dist, the package as shipped. `fakeProject` is a project: secrets whose HMAC check
// runs here as the platform's does, files, and streams that refuse a key used twice for another
// event (as the platform does; the same event again is a no-op). `host` is the worker hosting the
// package: a scope per `getItx`, counted, and a member gate that refuses unless `member` is set.
// `receiver(options)` hosts one more `pebble(options)` in the same project, on its own host.
// `signed` is the Pebble app: it signs as its protocol says.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "vite-plus/test";
import { pebble, type PebbleOptions } from "../dist/pebble.js";

const SECRET = "a-made-up-signing-secret";
const CONFIGURED = "events.iterate.com/integration/configured";
const ORIGIN = "https://pebble--iterate.example";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/pebble";

function fakeProject(
  secrets: Record<string, string> = { "/secrets/pebble-webhook": SECRET },
  options: { member?: boolean; pebble?: PebbleOptions } = {},
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
  const host = {
    getItx: () => {
      scopes.opened++;
      return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
    },
    auth: {
      require: () => (options.member ? null : new Response("Sign in\n", { status: 401 })),
    },
  };
  /** `pebble(pebbleOptions)` in this project, answering on `<slug>--iterate.example`. */
  const receiver = (pebbleOptions?: PebbleOptions) => {
    const integration = pebble(pebbleOptions);
    const origin = `https://${integration.routingSlug}--iterate.example`;
    const serve = (request: Request) => integration.fetch!(request, host);
    /** A GET of the package's `path`, as the edge hands it on: `basePath` is what a paths ingress
     *  strips, under the platform's origin. */
    const page = (path: string, basePath?: string) =>
      serve(
        new Request(`${basePath ? "https://os.iterate.example" : origin}${path}`, {
          headers: basePath ? { "x-iterate-base-path": basePath } : {},
        }),
      );
    /** The platform's `project/worker-updated` on `/`, at `offset`: the install hook. */
    const publish = (offset: number) =>
      integration.processEvent!({
        event: { type: "events.iterate.com/mind/worker-updated", path: "/", offset },
        itx,
      });
    return { integration, origin, serve, page, publish };
  };
  const registry = () => appended.filter((a) => a.path === "/integrations").map((a) => a.event);
  /** The events on `path`, in order. */
  const stream = (path: string) => appended.filter((a) => a.path === path).map((a) => a.event);
  return {
    ...receiver(options.pebble),
    receiver,
    appended,
    files,
    scopes,
    registry,
    stream,
    secrets,
  };
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
    trigger?: string;
    /** the audio part's bytes and name, as the app names it: `<recordingId>.m4a` */
    audio?: Uint8Array;
    name?: string;
    transcript?: string;
    /** where it is sent, and more headers: neither is signed */
    url?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Request> {
  const url = options.url ?? "https://pebble--iterate.example/webhook";
  const form = new FormData();
  form.set("recordedAt", "1760000000000");
  form.set("transcription", options.transcript ?? "buy oat milk");
  form.set(
    "audio",
    new File([options.audio ?? new Uint8Array([1, 2, 3])], options.name ?? "rec-42.m4a", {
      type: "audio/mp4",
    }),
  );
  const draft = new Request(url, { method: "POST", body: form });
  const body = new Uint8Array(await draft.arrayBuffer());
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const delivery = options.delivery ?? "d-1";
  const trigger = options.trigger ?? "hold";
  const prefix = `v1\n${timestamp}\n${delivery}\n${trigger}\n${options.test ? "1" : "0"}\n`;
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(Buffer.concat([Buffer.from(prefix), body]))
    .digest("hex");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": draft.headers.get("content-type")!,
      "x-index-webhook-version": options.version ?? "1",
      "x-index-timestamp": String(timestamp),
      "x-index-delivery": delivery,
      "x-index-trigger": trigger,
      "x-index-test": options.test ? "true" : "false",
      "x-index-signature": signature,
      ...options.headers,
    },
    body,
  });
}

/** `request` again, with some headers replaced: what someone who saw it could send. */
async function altered(request: Request, headers: Record<string, string>): Promise<Request> {
  const copy = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers)) copy.set(name, value);
  return new Request(request.url, {
    method: "POST",
    headers: copy,
    body: await request.arrayBuffer(),
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

// ------------------------------------------------- a receiver per ring (options)

const KIM = "a-made-up-secret-for-kim";
const SAM = "a-made-up-secret-for-sam";
const AUDIO = new Uint8Array([1, 2, 3]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A project with two rings, each its own receiver: Kim's and Sam's, each with its own secret. */
function twoRings(secrets: Record<string, string> = {}, member = false) {
  const project = fakeProject(
    {
      "/secrets/pebble-kim-webhook": KIM,
      "/secrets/pebble-sam-webhook": SAM,
      ...secrets,
    },
    { member, pebble: { slug: "pebble-kim" } },
  );
  const kim = { serve: project.serve, page: project.page, publish: project.publish };
  const sam = project.receiver({ slug: "pebble-sam" });
  return { project, kim, sam };
}

const effects = (project: ReturnType<typeof fakeProject>) => ({
  appended: project.appended,
  files: project.files,
});

test("pebble() and pebble({}) are the receiver the package always was", async () => {
  for (const options of [undefined, {}, { slug: undefined }]) {
    const project = fakeProject(undefined, { pebble: options });
    assert.equal(project.integration.routingSlug, "pebble");
    assert.equal((await project.serve(await signed())).status, 200);
    assert.deepEqual(Object.keys(project.files), ["/pebble/rec-42.m4a"]);
    assert.equal(project.stream("/pebble")[0].idempotencyKey, "pebble:d-1");
  }
});

test("each option names one part of a receiver, and pebble({ slug }) derives the rest from the slug", async () => {
  const project = fakeProject(
    { "/secrets/ring-two": KIM },
    {
      member: true,
      pebble: {
        slug: "ring-two",
        signingSecret: "/secrets/ring-two",
        stream: "/rings/two",
        audioDir: "/rings/two/audio",
        integration: "ring-two-card",
        title: "The second ring",
      },
    },
  );
  assert.equal(project.integration.routingSlug, "ring-two");
  assert.equal((await project.serve(await signed({ secret: KIM }))).status, 200);
  const audioPath = `/rings/two/audio/${sha256(AUDIO)}.m4a`;
  assert.deepEqual(Object.keys(project.files), [audioPath]);
  assert.deepEqual(project.stream("/rings/two"), [
    {
      type: "pebble/recording-created",
      idempotencyKey: "ring-two-card:d-1",
      payload: {
        deliveryId: "d-1",
        trigger: "hold",
        recordedAt: 1760000000000,
        transcript: "buy oat milk",
        audioPath,
      },
    },
  ]);
  await project.publish(3);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "ring-two-card:registry:/@3",
      payload: {
        integration: "ring-two-card",
        card: {
          title: "The second ring",
          description:
            "Every recording made with the ring: the transcript as a pebble/recording-created event on /rings/two, the audio as a project file.",
          icon: "https://www.google.com/s2/favicons?domain=repebble.com&sz=64",
          status: { kind: "ok" },
          actions: [
            { label: "Open", routingSlug: "ring-two", path: "/" },
            { label: "Recipe", url: RECIPE },
          ],
        },
      },
    },
  ]);
  const html = await (await project.page("/")).text();
  assert.match(html, /<h1>The second ring<\/h1>/);
  assert.match(html, /The project has the signing secret <code>\/secrets\/ring-two<\/code>/);

  // only the slug: every other name follows it
  const derived = fakeProject(
    { "/secrets/pebble-kim-webhook": KIM },
    { pebble: { slug: "pebble-kim" } },
  );
  assert.equal((await derived.serve(await signed({ secret: KIM }))).status, 200);
  assert.deepEqual(Object.keys(derived.files), [`/pebble-kim/${sha256(AUDIO)}.m4a`]);
  assert.equal(derived.stream("/pebble-kim")[0].idempotencyKey, "pebble-kim:d-1");
  await derived.publish(3);
  assert.equal(derived.registry()[0].payload.integration, "pebble-kim");
  assert.equal(derived.registry()[0].payload.card.title, "Pebble Index 01 (pebble-kim)");
});

test("each receiver checks its own secret: the other's signature is 401 both ways, and nothing is stored", async () => {
  const { project, kim, sam } = twoRings({ "/secrets/pebble-webhook": SECRET });
  for (const [serve, secret] of [
    [kim.serve, SAM],
    [kim.serve, SECRET],
    [sam.serve, KIM],
    [sam.serve, SECRET],
  ] as const) {
    assert.equal((await serve(await signed({ secret }))).status, 401, secret);
    assert.equal((await serve(await signed({ secret, test: true }))).status, 401, secret);
  }
  // the legacy receiver beside them refuses theirs too
  const legacy = project.receiver();
  for (const secret of [KIM, SAM])
    assert.equal((await legacy.serve(await signed({ secret }))).status, 401, secret);
  assert.deepEqual(effects(project), { appended: [], files: {} });
  assert.deepEqual(project.scopes, { opened: 10, disposed: 10 });
});

test("a receiver without its secret yet refuses every delivery, even one signed with another receiver's", async () => {
  const project = fakeProject(
    { "/secrets/pebble-webhook": SECRET },
    { pebble: { slug: "pebble-kim" } },
  );
  for (const secret of [SECRET, KIM])
    assert.equal((await project.serve(await signed({ secret }))).status, 401, secret);
  assert.deepEqual(effects(project), { appended: [], files: {} });
});

test("a receiver's test event is verified with its own secret and stores nothing", async () => {
  const { project, kim, sam } = twoRings();
  for (const [serve, secret] of [
    [kim.serve, KIM],
    [sam.serve, SAM],
  ] as const) {
    const res = await serve(await signed({ secret, test: true, trigger: "test-event" }));
    assert.deepEqual(await res.json(), { ok: true, test: true });
  }
  assert.deepEqual(effects(project), { appended: [], files: {} });
});

test("the same delivery and recording ids at two receivers land twice, apart: each on its stream, in its folder, under its key", async () => {
  const { project, kim, sam } = twoRings({ "/secrets/pebble-webhook": SECRET });
  const legacy = project.receiver();
  assert.equal((await kim.serve(await signed({ secret: KIM }))).status, 200);
  assert.equal((await sam.serve(await signed({ secret: SAM }))).status, 200);
  assert.equal((await legacy.serve(await signed())).status, 200);
  const file = `${sha256(AUDIO)}.m4a`;
  assert.deepEqual(Object.keys(project.files).sort(), [
    `/pebble-kim/${file}`,
    `/pebble-sam/${file}`,
    "/pebble/rec-42.m4a",
  ]);
  for (const [stream, key, audioPath] of [
    ["/pebble-kim", "pebble-kim:d-1", `/pebble-kim/${file}`],
    ["/pebble-sam", "pebble-sam:d-1", `/pebble-sam/${file}`],
    ["/pebble", "pebble:d-1", "/pebble/rec-42.m4a"],
  ]) {
    const events = project.stream(stream);
    assert.equal(events.length, 1, stream);
    assert.equal(events[0].idempotencyKey, key);
    assert.equal(events[0].payload.audioPath, audioPath);
    assert.equal(events[0].payload.deliveryId, "d-1");
  }
  assert.equal(project.appended.length, 3);
});

test("a retried delivery is idempotent: the same answer, one event, one file, though the app built its body again", async () => {
  const { project, kim } = twoRings();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await kim.serve(await signed({ secret: KIM, trigger: "single-click-hold" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.deepEqual(project.files, {
    [`/pebble-kim/${sha256(AUDIO)}.m4a`]: { contentType: "audio/mp4", data: AUDIO },
  });
  assert.equal(project.stream("/pebble-kim").length, 1);
});

test("a changed redelivery cannot replace accepted audio: 409, and the first recording stands", async () => {
  const { project, kim } = twoRings();
  assert.equal((await kim.serve(await signed({ secret: KIM }))).status, 200);
  const accepted = `/pebble-kim/${sha256(AUDIO)}.m4a`;
  const before = structuredClone(project.stream("/pebble-kim"));
  // the same delivery id, signed, with other audio of the same name and another transcript
  const other = new Uint8Array([9, 9, 9]);
  const res = await kim.serve(
    await signed({ secret: KIM, audio: other, transcript: "transfer everything" }),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(project.files[accepted], { contentType: "audio/mp4", data: AUDIO });
  assert.deepEqual(project.stream("/pebble-kim"), before);
  // its bytes stay behind under their own name, which no event names
  assert.deepEqual(
    Object.keys(project.files).sort(),
    [accepted, `/pebble-kim/${sha256(other)}.m4a`].sort(),
  );
});

test("another recording with the same part name gets a file of its own: no name collision replaces audio", async () => {
  const { project, kim } = twoRings();
  const second = new Uint8Array([4, 5, 6]);
  assert.equal((await kim.serve(await signed({ secret: KIM }))).status, 200);
  assert.equal(
    (await kim.serve(await signed({ secret: KIM, delivery: "d-2", audio: second }))).status,
    200,
  );
  const [first, next] = project.stream("/pebble-kim").map((event) => event.payload.audioPath);
  assert.equal(first, `/pebble-kim/${sha256(AUDIO)}.m4a`);
  assert.equal(next, `/pebble-kim/${sha256(second)}.m4a`);
  assert.deepEqual(project.files[first].data, AUDIO);
  assert.deepEqual(project.files[next].data, second);
});

test("a replay whose unsigned content-type was changed is 400 and stores nothing", async () => {
  for (const options of [undefined, { slug: "pebble-kim" }]) {
    const secret = options ? KIM : SECRET;
    const project = fakeProject(
      { "/secrets/pebble-webhook": SECRET, "/secrets/pebble-kim-webhook": KIM },
      { pebble: options },
    );
    const original = await signed({ secret });
    for (const contentType of [
      "multipart/form-data; boundary=another-boundary",
      "application/x-www-form-urlencoded",
    ]) {
      const res = await project.serve(
        await altered(original.clone(), { "content-type": contentType }),
      );
      assert.equal(res.status, 400, contentType);
    }
    assert.deepEqual(effects(project), { appended: [], files: {} });
  }
});

test("a trigger changed after signing is 401: no gesture can pass for another", async () => {
  const { project, kim } = twoRings();
  const original = await signed({ secret: KIM, trigger: "single-click-hold" });
  for (const trigger of ["double-click-hold", "click", "triple-click", "unknown", ""])
    assert.equal(
      (await kim.serve(await altered(original.clone(), { "x-index-trigger": trigger }))).status,
      401,
      trigger,
    );
  assert.deepEqual(effects(project), { appended: [], files: {} });
  // the trigger the app signed is the event's, verbatim: a consumer allowlists the ones it knows
  assert.equal((await kim.serve(original)).status, 200);
  assert.equal(project.stream("/pebble-kim")[0].payload.trigger, "single-click-hold");
});

test("a receiver's names come from the worker's code: the host and routing slug a request names change nothing", async () => {
  const { project, kim, sam } = twoRings();
  // Kim's delivery, addressed to Kim's host and slug, handed to Sam's receiver
  const toKim = {
    url: "https://pebble-kim--iterate.example/webhook?receiver=pebble-kim",
    headers: { "x-iterate-routing-slug": "pebble-kim" },
  };
  assert.equal((await sam.serve(await signed({ secret: KIM, ...toKim }))).status, 401);
  assert.deepEqual(effects(project), { appended: [], files: {} });
  // Sam's delivery, addressed to Kim, lands on Sam's stream, in Sam's folder
  assert.equal((await sam.serve(await signed({ secret: SAM, ...toKim }))).status, 200);
  assert.deepEqual(Object.keys(project.files), [`/pebble-sam/${sha256(AUDIO)}.m4a`]);
  assert.equal(project.stream("/pebble-sam").length, 1);
  assert.equal(project.stream("/pebble-kim").length, 0);
  assert.equal((await kim.serve(await signed({ secret: SAM }))).status, 401);
});

/** The registry's limits (iterate/integrations), as the google package's tests check them. */
function assertFits(event: any) {
  const { payload } = event;
  assert.equal(event.type, CONFIGURED);
  assert.match(payload.integration, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  const { card } = payload;
  assert.ok(card.title.length >= 1 && card.title.length <= 80);
  assert.ok(card.description.length <= 400);
  assert.ok(card.actions.length <= 4);
  for (const button of card.actions)
    assert.deepEqual(
      Object.keys(button).sort(),
      "url" in button ? ["label", "url"] : ["label", "path", "routingSlug"],
    );
}

test("one publish lands every receiver's card, each under its own key, with its own title, stream, button and status", async () => {
  const project = fakeProject(
    { "/secrets/pebble-kim-webhook": KIM },
    { pebble: { slug: "pebble-kim" } },
  );
  const sam = project.receiver({ slug: "pebble-sam" });
  const legacy = project.receiver();
  for (let attempt = 0; attempt < 2; attempt++)
    for (const publish of [project.publish, sam.publish, legacy.publish]) await publish(7);
  const cards = project.registry();
  assert.deepEqual(
    cards.map((event) => [
      event.idempotencyKey,
      event.payload.integration,
      event.payload.card.title,
      event.payload.card.status.kind,
      event.payload.card.actions[0].routingSlug,
      /event on (\S+),/.exec(event.payload.card.description)![1],
    ]),
    [
      [
        "pebble-kim:registry:/@7",
        "pebble-kim",
        "Pebble Index 01 (pebble-kim)",
        "ok",
        "pebble-kim",
        "/pebble-kim",
      ],
      [
        "pebble-sam:registry:/@7",
        "pebble-sam",
        "Pebble Index 01 (pebble-sam)",
        "attention",
        "pebble-sam",
        "/pebble-sam",
      ],
      ["pebble:registry:/@7", "pebble", "Pebble Index 01", "attention", "pebble", "/pebble"],
    ],
  );
  cards.forEach(assertFits);
});

test("each receiver's page shows its own title, status and webhook URL, for members only", async () => {
  const { project, kim, sam } = twoRings({}, true);
  delete project.secrets["/secrets/pebble-sam-webhook"];
  const kimPage = await (await kim.page("/")).text();
  assert.match(kimPage, /<h1>Pebble Index 01 \(pebble-kim\)<\/h1>/);
  assert.match(
    kimPage,
    /Set up\. The project has the signing secret <code>\/secrets\/pebble-kim-webhook<\/code>/,
  );
  assert.ok(kimPage.includes(`data-copy="https://pebble-kim--iterate.example/webhook"`));
  assert.match(kimPage, /event on \/pebble-kim,/);

  const samPage = await (await sam.page("/", "/projects/iterate/pebble-sam")).text();
  assert.match(samPage, /<h1>Pebble Index 01 \(pebble-sam\)<\/h1>/);
  assert.match(samPage, /no signing secret <code>\/secrets\/pebble-sam-webhook<\/code> yet/);
  const hint = `Set up Pebble Index 01 (pebble-sam) in my iterate project: the receiver on routing slug pebble-sam, with the signing secret /secrets/pebble-sam-webhook. Follow the recipe at ${RECIPE}`;
  assert.ok(samPage.includes(`data-copy="${hint}"`), hint);
  assert.ok(
    samPage.includes(`data-copy="https://os.iterate.example/projects/iterate/pebble-sam/webhook"`),
  );
  for (const html of [kimPage, samPage]) {
    assert.ok(!html.includes(KIM) && !html.includes(SAM));
  }
  assert.ok(!samPage.includes("pebble-kim"));
  assert.ok(!kimPage.includes("pebble-sam"));

  const outsider = fakeProject({}, { pebble: { slug: "pebble-kim" } });
  const res = await outsider.page("/");
  assert.equal(res.status, 401);
  assert.equal(await res.text(), "Sign in\n");
  assert.deepEqual(outsider.scopes, { opened: 0, disposed: 0 });
});

test("an option it cannot use throws when the worker is built", () => {
  const refused: unknown[] = [
    { slug: "Pebble" },
    { slug: "pebble--kim" },
    { slug: "pebble_kim" },
    { slug: "1pebble" },
    { slug: "" },
    { slug: "files" },
    { slug: "a".repeat(41) },
    { signingSecret: "secrets/pebble-kim" },
    { signingSecret: "/secrets/.." },
    { signingSecret: "/secrets/a/b" },
    { signingSecret: "/other/pebble-kim" },
    { stream: "/" },
    { stream: "pebble-kim" },
    { stream: "/a/../b" },
    { stream: "/pebble-kim/" },
    { stream: "/secrets/pebble-kim" },
    { stream: "/integrations" },
    { audioDir: "/a/./b" },
    { audioDir: "" },
    { integration: "Kim" },
    { title: "" },
    { title: "   " },
    { title: "x".repeat(81) },
    { title: "line\nbreak" },
    { slug: 7 },
    { secret: "/secrets/pebble-kim-webhook" },
    "pebble-kim",
    null,
  ];
  for (const options of refused)
    assert.throws(
      () => pebble(options as any),
      /^TypeError: pebble\(\): /,
      JSON.stringify(options),
    );
});

/** `body` as the app would sign it, sent with `contentType`. */
function signedBody(body: Uint8Array, contentType: string, secret: string, trigger: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const prefix = `v1\n${timestamp}\nd-9\n${trigger}\n0\n`;
  return new Request("https://pebble--iterate.example/webhook", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-index-webhook-version": "1",
      "x-index-timestamp": String(timestamp),
      "x-index-delivery": "d-9",
      "x-index-trigger": trigger,
      "x-index-signature": createHmac("sha256", secret)
        .update(Buffer.concat([Buffer.from(prefix), body]))
        .digest("hex"),
    },
    body,
  });
}

test("a signed body that is no recording is 400 and stores nothing: a click's JSON button event, a form with no recordedAt", async () => {
  for (const [options, secret] of [
    [undefined, SECRET],
    [{ slug: "pebble-kim" }, KIM],
  ] as const) {
    const project = fakeProject(
      { "/secrets/pebble-webhook": SECRET, "/secrets/pebble-kim-webhook": KIM },
      { pebble: options },
    );
    const click = new TextEncoder().encode(JSON.stringify({ gesture: "click" }));
    assert.equal(
      (await project.serve(signedBody(click, "application/json", secret, "click"))).status,
      400,
    );
    const form = new FormData();
    form.set("transcription", "buy oat milk");
    const draft = new Request("https://pebble--iterate.example/webhook", {
      method: "POST",
      body: form,
    });
    const body = new Uint8Array(await draft.arrayBuffer());
    const res = await project.serve(
      signedBody(body, draft.headers.get("content-type")!, secret, "single-click-hold"),
    );
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "missing recordedAt\n");
    assert.deepEqual(effects(project), { appended: [], files: {} });
  }
});

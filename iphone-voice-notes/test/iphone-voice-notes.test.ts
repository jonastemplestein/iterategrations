// Runs against dist, the package as shipped. `fakeProject` is a project: a token secret compared
// as the platform's verifyEquals does, files, kv, Workers AI (a fake Whisper that records what it
// was sent), and streams that refuse a key used twice for another event (as the platform does; the
// same event again is a no-op). `host` is the worker hosting the package: a scope per `getItx`,
// counted, and a member gate that refuses unless `member` is set.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vite-plus/test";
import { iphoneVoiceNotes } from "../dist/iphone-voice-notes.js";

const TOKEN = "a-made-up-token";
const CONFIGURED = "events.iterate.com/integration/configured";
const ORIGIN = "https://iphone-voice-notes--iterate.example";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/iphone-voice-notes";
const AUDIO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);
const ID = createHash("sha256").update(AUDIO).digest("hex").slice(0, 32);

function fakeProject(
  secrets: Record<string, string> = { "/secrets/iphone-voice-notes": TOKEN },
  options: {
    member?: boolean;
    whisper?: (body: any) => Promise<unknown>;
    kv?: Record<string, unknown>;
    integration?: Parameters<typeof iphoneVoiceNotes>[0];
  } = {},
) {
  const appended: { path: string; event: any }[] = [];
  const files: Record<string, { contentType?: string; data: Uint8Array }> = {};
  const whispered: { model: string; body: any }[] = [];
  const scopes = { opened: 0, disposed: 0 };
  const itx: any = {
    secrets: {
      list: async () => Object.keys(secrets).map((path) => ({ path })),
      verifyEquals: async (path: string, input: { value: string }) =>
        secrets[path] !== undefined && secrets[path] === input.value,
    },
    files: {
      get: (path: string) => ({
        put: async (input: { contentType?: string; data: Uint8Array }) =>
          void (files[path] = input),
        bytes: async () => {
          if (!files[path]) throw new Error(`no file at ${path}`);
          return files[path].data;
        },
      }),
    },
    ai: {
      run: async (model: string, body: any) => {
        whispered.push({ model, body });
        return (options.whisper ?? (async () => ({ text: " buy oat milk " })))(body);
      },
    },
    kv: { get: async (key: string) => options.kv?.[key] ?? null },
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
  const integration = iphoneVoiceNotes(options.integration);
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
  /** The platform handing the hook one of the stream's events, as the worker does after an append. */
  const deliver = (offset: number) =>
    integration.processEvent!({
      event: { ...appended[offset]!.event, path: appended[offset]!.path, offset },
      itx,
    });
  /** The platform's `project/worker-updated` on `/`, at `offset`: the install hook. */
  const publish = (offset: number) =>
    integration.processEvent!({
      event: { type: "events.iterate.com/project/worker-updated", path: "/", offset },
      itx,
    });
  const registry = () => appended.filter((a) => a.path === "/integrations").map((a) => a.event);
  const notes = () => appended.filter((a) => a.path === "/iphone-voice-notes").map((a) => a.event);
  return {
    integration,
    appended,
    files,
    whispered,
    scopes,
    serve,
    page,
    deliver,
    publish,
    registry,
    notes,
    secrets,
  };
}

/** An upload as the shortcut makes it: the raw audio as the body, the token in its header. */
function upload(
  options: {
    token?: string | null;
    body?: Uint8Array;
    contentType?: string;
    test?: boolean;
    method?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["x-voice-note-token"] = options.token ?? TOKEN;
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  if (options.test) headers["x-voice-note-test"] = "true";
  const method = options.method ?? "POST";
  return new Request(`${ORIGIN}/webhook`, {
    method,
    headers,
    body: method === "POST" ? (options.body ?? AUDIO) : undefined,
  });
}

test("it answers the iphone-voice-notes routing slug, or the one it is given; a webhook is public, and each request opens one scope and releases it", async () => {
  const project = fakeProject();
  assert.equal(project.integration.routingSlug, "iphone-voice-notes");
  assert.equal(
    fakeProject({}, { integration: { slug: "voice" } }).integration.routingSlug,
    "voice",
  );
  assert.equal((await project.serve(upload())).status, 200);
  assert.equal((await project.serve(upload({ method: "GET" }))).status, 405);
  assert.deepEqual(project.scopes, { opened: 2, disposed: 2 });
});

test("an upload with the token stores its audio under its hash and lands once as recording-received on /iphone-voice-notes", async () => {
  const project = fakeProject();
  const first = await project.serve(upload({ contentType: "audio/x-m4a" }));
  assert.deepEqual(await first.json(), { ok: true, recordingId: ID });
  const again = await project.serve(upload({ contentType: "audio/x-m4a" }));
  assert.deepEqual(await again.json(), { ok: true, recordingId: ID, duplicate: true });
  assert.deepEqual(project.files[`/iphone-voice-notes/${ID}.m4a`], {
    contentType: "audio/x-m4a",
    data: AUDIO,
  });
  const notes = project.notes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "iphone-voice-notes/recording-received");
  assert.equal(notes[0].idempotencyKey, `iphone-voice-notes:${ID}`);
  const { receivedAt, ...rest } = notes[0].payload;
  assert.ok(Math.abs(Date.parse(receivedAt) - Date.now()) < 5000);
  assert.deepEqual(rest, {
    recordingId: ID,
    audioPath: `/iphone-voice-notes/${ID}.m4a`,
    contentType: "audio/x-m4a",
    bytes: AUDIO.length,
    test: false,
  });
});

test("a body with no audio content type is taken for M4A; an MP3 keeps its own; a test upload is flagged", async () => {
  const project = fakeProject();
  await project.serve(upload({ contentType: "application/octet-stream" }));
  assert.equal(project.files[`/iphone-voice-notes/${ID}.m4a`]!.contentType, "audio/mp4");
  const mp3 = new Uint8Array([73, 68, 51]);
  await project.serve(upload({ body: mp3, contentType: "audio/mpeg", test: true }));
  const id = createHash("sha256").update(mp3).digest("hex").slice(0, 32);
  assert.equal(project.files[`/iphone-voice-notes/${id}.mp3`]!.contentType, "audio/mpeg");
  assert.equal(project.notes()[1].payload.test, true);
});

test("a missing or wrong token is 401, as is any token before the secret exists, an empty body 400, and nothing is stored", async () => {
  const project = fakeProject();
  assert.equal((await project.serve(upload({ token: null }))).status, 401);
  assert.equal((await project.serve(upload({ token: "another" }))).status, 401);
  assert.equal((await fakeProject({}).serve(upload())).status, 401);
  assert.equal((await project.serve(upload({ body: new Uint8Array() }))).status, 400);
  assert.deepEqual(project.appended, []);
  assert.deepEqual(project.files, {});
});

test("an upload over 25 MiB is 413 and stores nothing", async () => {
  const project = fakeProject();
  const res = await project.serve(upload({ body: new Uint8Array(25 * 1024 * 1024 + 1) }));
  assert.equal(res.status, 413);
  assert.deepEqual(project.files, {});
});

// ------------------------------------------------------------- the transcript

test("the hook transcribes a received recording with Whisper, primed from kv, and lands recording-transcribed once", async () => {
  const project = fakeProject(undefined, {
    kv: { "household/vocabulary": "Priya, Tomasz, Oakfield Road" },
    integration: { vocabularyKey: "household/vocabulary" },
  });
  await project.serve(upload({ test: true }));
  for (let retry = 0; retry < 2; retry++) await project.deliver(0);
  assert.equal(project.whispered.length, 2);
  assert.deepEqual(project.whispered[0], {
    model: "@cf/openai/whisper-large-v3-turbo",
    body: {
      audio: Buffer.from(AUDIO).toString("base64"),
      task: "transcribe",
      initial_prompt: "Priya, Tomasz, Oakfield Road",
    },
  });
  const [received, transcribed, ...more] = project.notes();
  assert.deepEqual(more, []);
  assert.deepEqual(transcribed, {
    type: "iphone-voice-notes/recording-transcribed",
    idempotencyKey: `iphone-voice-notes:transcribed:${ID}`,
    payload: {
      recordingId: ID,
      receivedAt: received.payload.receivedAt,
      audioPath: `/iphone-voice-notes/${ID}.m4a`,
      transcript: "buy oat milk",
      model: "@cf/openai/whisper-large-v3-turbo",
      error: null,
      test: true,
    },
  });
});

test("a transcription that fails still lands, with no transcript and the error", async () => {
  const project = fakeProject(undefined, {
    whisper: async () => {
      throw new Error("AiError: 3010: Invalid or incomplete input");
    },
  });
  await project.serve(upload());
  await project.deliver(0);
  const { transcript, error } = project.notes()[1].payload;
  assert.equal(transcript, null);
  assert.match(error, /Invalid or incomplete input/);
  assert.equal("initial_prompt" in project.whispered[0]!.body, false);
});

// --------------------------------------------- the Dash's Integrations page

const card = (status: object) => ({
  title: "iPhone voice notes",
  description:
    "Hold the iPhone's Action Button and speak: each recording lands as an audio file and, transcribed, as an iphone-voice-notes/recording-transcribed event on /iphone-voice-notes.",
  icon: "https://www.google.com/s2/favicons?domain=apple.com&sz=64",
  status,
  actions: [
    { label: "Open", routingSlug: "iphone-voice-notes", path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

test("the install hook registers the card, keyed by the event's path and offset: attention until the token exists, ok after", async () => {
  const project = fakeProject({});
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "iphone-voice-notes:registry:/@5",
      payload: {
        integration: "iphone-voice-notes",
        card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
      },
    },
  ]);
  project.secrets["/secrets/iphone-voice-notes"] = TOKEN;
  await project.publish(5); // the same event again, now set up: its key is spent, and that is fine
  await project.publish(6);
  assert.deepEqual(project.registry()[1], {
    type: CONFIGURED,
    idempotencyKey: "iphone-voice-notes:registry:/@6",
    payload: { integration: "iphone-voice-notes", card: card({ kind: "ok" }) },
  });
  assert.equal(project.registry().length, 2);
});

test("the hook ignores every other event, and a recording-received on another path", async () => {
  const project = fakeProject();
  for (const event of [
    { type: "pebble/recording-created", path: "/pebble", offset: 1 },
    {
      type: "iphone-voice-notes/recording-received",
      path: "/elsewhere",
      offset: 2,
      payload: { recordingId: ID, audioPath: "/x.m4a" },
    },
  ])
    await project.integration.processEvent!({ event, itx: {} as any });
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

test("the page shows the status, the webhook URL and the header name with Copy buttons, with the base path a paths ingress strips", async () => {
  const project = fakeProject({}, { member: true });
  let res = await project.page("/");
  let html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /<h1>iPhone voice notes<\/h1>/);
  assert.match(html, /Set up by your coding agent: see the recipe/);
  const hint = `Set up iPhone voice notes in my iterate project. Follow the recipe at ${RECIPE}`;
  assert.ok(html.includes(`data-copy="${hint}"`), hint);
  assert.ok(html.includes(`data-copy="${ORIGIN}/webhook"`));
  assert.ok(html.includes(`data-copy="x-voice-note-token"`));
  assert.ok(html.includes(`href="${RECIPE}"`));

  project.secrets["/secrets/iphone-voice-notes"] = TOKEN;
  res = await project.page("/", "/projects/iterate/iphone-voice-notes");
  html = await res.text();
  assert.match(
    html,
    /Set up\. The project has the token <code>\/secrets\/iphone-voice-notes<\/code>/,
  );
  assert.doesNotMatch(html, /coding agent/);
  assert.ok(
    html.includes(
      `data-copy="https://os.iterate.example/projects/iterate/iphone-voice-notes/webhook"`,
    ),
  );
  assert.ok(!html.includes(TOKEN));
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

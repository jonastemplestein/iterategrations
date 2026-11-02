import { servePage } from "./page.js";

/** The project, as this package uses it: what a config worker's `itx` already has. */
export type PebbleItx = {
  secrets: {
    list(): Promise<{ path: string }[]>;
    verifyHmac(
      path: string,
      input: { payload: string | Uint8Array; signature: string; field?: string },
    ): Promise<boolean>;
  };
  files: {
    get(path: string): {
      put(input: {
        contentType?: string;
        data: Uint8Array | ArrayBuffer | string;
      }): Promise<unknown>;
    };
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it. */
export type IntegrationHost = {
  getItx(): PebbleItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: PebbleItx }): Promise<void>;
};

/** What `pebble(options)` takes: one receiver's names, for a project with a receiver per ring.
 *  Each is optional, and each default comes from `slug`, so `pebble({ slug: "pebble-ada" })` is a
 *  receiver of its own: its own host, signing secret, stream, audio folder and card. With no
 *  options at all, `pebble()` is the receiver this package always was. */
export type PebbleOptions = {
  /** The routing slug it answers. Default `pebble`. */
  slug?: string;
  /** The signing secret its requests are checked with. Default `/secrets/<slug>-webhook`. */
  signingSecret?: string;
  /** The stream its `pebble/recording-created` events land on. Default `/<slug>`. */
  stream?: string;
  /** The project-file folder its audio goes in. Default: the stream's path. */
  audioDir?: string;
  /** Its card's key on the Dash's Integrations page. Default: the slug. */
  integration?: string;
  /** Its card's and its page's title. Default `Pebble Index 01`, with the integration in
   *  parentheses when that is not `pebble`. */
  title?: string;
};

/** One receiver, every name resolved: what its requests, its page and its hook use. All of it comes
 *  from the worker's code, never from a request. */
type Receiver = {
  slug: string;
  signingSecret: string;
  stream: string;
  audioDir: string;
  integration: string;
  title: string;
  description: string;
  /** `pebble()` with no options. Its audio is named by its multipart part, as it always was:
   *  `/pebble/<recordingId>.m4a`, so a later delivery with the same name replaces that file. A
   *  receiver with options names the audio by its bytes instead, and never replaces a file. */
  legacy: boolean;
};

const MAX_CLOCK_SKEW_SECONDS = 300;

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

const SLUG = "pebble";
const TITLE = "Pebble Index 01";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/pebble";

/** A routing slug (iterate/project-ingress `ROUTING_SLUG`), which the registry also takes as an
 *  integration's key: a DNS label that starts with a letter. */
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A secret's path as iterate takes it: `/secrets/<name>`, never `.` or `..`. */
const SECRET_PATH = /^\/secrets\/(?!\.\.?$)[a-zA-Z0-9._-]{1,100}$/;
/** An absolute path of plain segments, never `.` or `..`, and no trailing slash. */
const PATH = /^(?:\/(?!\.\.?(?:\/|$))[a-zA-Z0-9._-]+)+$/;
/** Some text and no control characters: the title is shown on the Dash and on the page. */
const TITLE_TEXT = /^(?=.*\S)[^\p{Cc}]{1,80}$/u;
const OPTIONS = new Set(["slug", "signingSecret", "stream", "audioDir", "integration", "title"]);

/** A `pebble(options)` value it cannot use: thrown when the worker is built, so a probe of the
 *  patched config repo fails before anything is committed. */
function refuse(option: string, value: unknown, rule: string): never {
  throw new TypeError(`pebble(): ${option} must be ${rule}, got ${JSON.stringify(value)}`);
}

function check(option: string, value: unknown, pattern: RegExp, rule: string, max = 200): string {
  if (typeof value !== "string" || value.length > max || !pattern.test(value))
    refuse(option, value, rule);
  return value;
}

function receiverOf(options: PebbleOptions): Receiver {
  if (typeof options !== "object" || options === null || Array.isArray(options))
    refuse("options", options, "an object");
  for (const key of Object.keys(options))
    if (!OPTIONS.has(key))
      throw new TypeError(`pebble(): no option ${key}; the options are ${[...OPTIONS].join(", ")}`);
  const legacy = Object.values(options).every((value) => value === undefined);
  const slug = check("slug", options.slug ?? SLUG, NAME, "a routing slug like pebble-ada", 40);
  if (slug === "files") refuse("slug", slug, "another slug than the platform's files");
  const stream = check("stream", options.stream ?? `/${slug}`, PATH, "a path like /pebble-ada");
  if (stream === "/integrations" || stream === "/secrets" || stream.startsWith("/secrets/"))
    refuse("stream", stream, "a stream outside /secrets and other than /integrations");
  const integration = check(
    "integration",
    options.integration ?? slug,
    NAME,
    "a key like pebble-ada",
    40,
  );
  return {
    slug,
    signingSecret: check(
      "signingSecret",
      options.signingSecret ?? `/secrets/${slug}-webhook`,
      SECRET_PATH,
      "a secret's path like /secrets/pebble-ada-webhook",
    ),
    stream,
    audioDir: check("audioDir", options.audioDir ?? stream, PATH, "a path like /pebble-ada"),
    integration,
    title: check(
      "title",
      options.title ?? (integration === SLUG ? TITLE : `${TITLE} (${integration})`),
      TITLE_TEXT,
      "1 to 80 characters",
    ),
    description: `Every recording made with the ring: the transcript as a pebble/recording-created event on ${stream}, the audio as a project file.`,
    legacy,
  };
}

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets the ring up
 *  by the recipe, so the card links to the page and to the recipe, and it is "ok" once the signing
 *  secret exists. */
const cardOf = (receiver: Receiver, signing: boolean) => ({
  title: receiver.title,
  description: receiver.description,
  icon: "https://www.google.com/s2/favicons?domain=repebble.com&sz=64",
  status: signing
    ? { kind: "ok" }
    : { kind: "attention", text: "Set up by your coding agent: see the recipe" },
  actions: [
    { label: "Open", routingSlug: receiver.slug, path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

/** Whether the signing secret exists: the card's status and the page's. */
const hasSigningSecret = async (itx: PebbleItx, receiver: Receiver): Promise<boolean> =>
  (await itx.secrets.list()).some((secret) => secret.path === receiver.signingSecret);

/** The audio's SHA-256, as lowercase hex: a configured receiver's file name. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Pebble Index 01's webhook (webhook protocol version 1): verify the signature with the
 *  receiver's secret, store the audio as a project file in its folder and publish
 *  `pebble/recording-created` on its stream. */
async function receive(request: Request, itx: PebbleItx, receiver: Receiver): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  if (request.headers.get("x-index-webhook-version") !== "1")
    return new Response("unsupported webhook version\n", { status: 400 });
  const timestamp = Number(request.headers.get("x-index-timestamp"));
  const deliveryId = request.headers.get("x-index-delivery") ?? "";
  const trigger = request.headers.get("x-index-trigger") ?? "";
  const isTest = request.headers.get("x-index-test") === "true";
  if (!Number.isInteger(timestamp) || !deliveryId)
    return new Response("missing timestamp or delivery id\n", { status: 400 });
  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_CLOCK_SKEW_SECONDS)
    return new Response("expired\n", { status: 401 });

  // The app signs "v1\n<timestamp>\n<delivery>\n<trigger>\n<0|1>\n" followed by the raw body.
  const body = new Uint8Array(await request.arrayBuffer());
  const prefix = new TextEncoder().encode(
    "v1\n" + timestamp + "\n" + deliveryId + "\n" + trigger + "\n" + (isTest ? "1" : "0") + "\n",
  );
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const signature = request.headers.get("x-index-signature") ?? "";
  const genuine = await itx.secrets.verifyHmac(receiver.signingSecret, {
    payload: signed,
    signature,
  });
  if (!genuine) return new Response("bad signature\n", { status: 401 });
  if (isTest) return Response.json({ ok: true, test: true });

  // The signature covers the body, not its content-type header. The app's body is multipart and
  // opens with its boundary, so only that boundary reads it: another content type or boundary is
  // refused, and cannot make the same signed bytes read as another form.
  const contentType = request.headers.get("content-type") ?? "";
  const boundary = /^multipart\/form-data;\s*boundary=([A-Za-z0-9'()+_,./:=?-]{1,70})$/i.exec(
    contentType,
  )?.[1];
  const opening = boundary && new TextEncoder().encode(`--${boundary}\r\n`);
  if (!opening || !opening.every((byte, at) => body[at] === byte))
    return new Response("not the app's multipart form\n", { status: 400 });
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return new Response("unreadable form\n", { status: 400 });
  }
  const recordedAtField = form.get("recordedAt");
  const recordedAt = typeof recordedAtField === "string" ? Number(recordedAtField) : NaN;
  if (!recordedAtField || !Number.isFinite(recordedAt))
    return new Response("missing recordedAt\n", { status: 400 });
  const transcription = form.get("transcription");
  const audio = form.get("audio");
  const audioBytes = audio instanceof File ? new Uint8Array(await audio.arrayBuffer()) : null;
  // The legacy receiver keeps the name the app gives the part, <recordingId>.m4a. A configured one
  // names the file by its bytes: a path only ever holds the bytes it was named for, so neither a
  // changed redelivery nor another recording of the same name can replace audio it accepted.
  const audioPath = !(audio instanceof File && audioBytes)
    ? null
    : receiver.legacy
      ? `${receiver.audioDir}/${/^[A-Za-z0-9._-]+$/.test(audio.name) ? audio.name : recordedAt + ".m4a"}`
      : `${receiver.audioDir}/${await sha256(audioBytes)}.m4a`;

  if (audioPath && audioBytes)
    await itx.files.get(audioPath).put({ contentType: "audio/mp4", data: audioBytes });
  try {
    await itx.cd(receiver.stream).append({
      type: "pebble/recording-created",
      // a redelivery is the same event with the same payload
      idempotencyKey: `${receiver.integration}:${deliveryId}`,
      payload: {
        deliveryId,
        trigger,
        recordedAt,
        transcript: typeof transcription === "string" ? transcription : null,
        audioPath,
      },
    });
  } catch (error) {
    // The delivery id landed before with another recording. A configured receiver kept the first
    // and replaced no file; the legacy one has replaced the file by now, so it answers as it did.
    if (receiver.legacy || (error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT")
      throw error;
    return new Response("this delivery id came before with another recording\n", {
      status: 409,
    });
  }
  return Response.json({ ok: true });
}

/** A project's Pebble Index 01 receiver, as an integration its worker hosts:
 *  `const integrations: Integration[] = [pebble()];`
 *
 *  On its routing slug (`pebble` by default) it answers the Pebble app's webhook at `/webhook` and,
 *  for members only, its page at `/`; any other path is a 404. Its install hook
 *  (`project/worker-updated`) lists it on the Dash's Integrations page.
 *
 *  A project with two rings hosts a receiver for each, every name its own (`PebbleOptions`):
 *  `[pebble({ slug: "pebble-ada" }), pebble({ slug: "pebble-sam" })]`. It throws on an option it
 *  cannot use. */
export function pebble(options: PebbleOptions = {}): Integration {
  const receiver = receiverOf(options);
  return {
    routingSlug: receiver.slug,
    async fetch(request, host) {
      const { pathname } = new URL(request.url);
      if (pathname === "/webhook") {
        using itx = host.getItx();
        return await receive(request, itx, receiver);
      }
      const denied = host.auth.require(request);
      if (denied) return denied;
      if (request.method !== "GET" || pathname !== "/")
        return new Response("Not found\n", { status: 404 });
      using itx = host.getItx();
      return servePage(request, {
        title: receiver.title,
        description: receiver.description,
        recipe: RECIPE,
        secret: receiver.signingSecret,
        saved: await hasSigningSecret(itx, receiver),
        hint: receiver.legacy
          ? `Set up ${TITLE} in my iterate project. Follow the recipe at ${RECIPE}`
          : `Set up ${receiver.title} in my iterate project: the receiver on routing slug ${receiver.slug}, with the signing secret ${receiver.signingSecret}. Follow the recipe at ${RECIPE}`,
      });
    },
    async processEvent({ event, itx }) {
      if (event.type !== WORKER_UPDATED) return;
      const signing = await hasSigningSecret(itx, receiver);
      // The platform retries an event, so this card may have landed already, perhaps with what was
      // true then (IDEMPOTENCY_CONFLICT): not an error, and the next publish registers it again.
      // Each receiver keys its card by its own integration, so two of them on one event both land.
      await itx
        .cd("/integrations")
        .append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `${receiver.integration}:registry:${event.path}@${event.offset}`,
          payload: { integration: receiver.integration, card: cardOf(receiver, signing) },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
        });
    },
  };
}

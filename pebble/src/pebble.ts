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

const SIGNING_SECRET = "/secrets/pebble-webhook";
const MAX_CLOCK_SKEW_SECONDS = 300;

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets the ring up
 *  by the recipe, so the card links there, and it is "ok" once the signing secret exists. */
const cardOf = (signing: boolean) => ({
  title: "Pebble Index 01",
  description:
    "Every recording made with the ring: the transcript as a pebble/recording-created event on /pebble, the audio as a project file.",
  status: signing
    ? { kind: "ok" }
    : { kind: "attention", text: "Set up by your coding agent: see the recipe" },
  actions: [
    {
      label: "Recipe",
      url: "https://github.com/jonastemplestein/iterategrations/tree/main/pebble",
    },
  ],
});

/** Pebble Index 01's webhook (webhook protocol version 1): verify the signature, store the audio
 *  as the project file /pebble/<recordingId>.m4a and publish `pebble/recording-created` on /pebble. */
async function receive(request: Request, itx: PebbleItx): Promise<Response> {
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
  const genuine = await itx.secrets.verifyHmac(SIGNING_SECRET, { payload: signed, signature });
  if (!genuine) return new Response("bad signature\n", { status: 401 });
  if (isTest) return Response.json({ ok: true, test: true });

  const form = await new Response(body, {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  }).formData();
  const recordedAt = Number(form.get("recordedAt"));
  if (!Number.isFinite(recordedAt)) return new Response("missing recordedAt\n", { status: 400 });
  const transcription = form.get("transcription");
  const audio = form.get("audio");
  // the app names the part <recordingId>.m4a
  const audioName =
    audio instanceof File && /^[A-Za-z0-9._-]+$/.test(audio.name)
      ? audio.name
      : recordedAt + ".m4a";
  const audioPath = audio instanceof File ? "/pebble/" + audioName : null;
  const audioBytes = audio instanceof File ? new Uint8Array(await audio.arrayBuffer()) : null;

  if (audioPath && audioBytes)
    await itx.files.get(audioPath).put({ contentType: "audio/mp4", data: audioBytes });
  await itx.cd("/pebble").append({
    type: "pebble/recording-created",
    // a redelivery is the same event with the same payload
    idempotencyKey: "pebble:" + deliveryId,
    payload: {
      deliveryId,
      trigger,
      recordedAt,
      transcript: typeof transcription === "string" ? transcription : null,
      audioPath,
    },
  });
  return Response.json({ ok: true });
}

/** A project's Pebble Index 01 receiver, as an integration its worker hosts:
 *  `const integrations: Integration[] = [pebble()];`
 *
 *  On the `pebble` routing slug it answers the Pebble app's webhook. Its install hook
 *  (`project/worker-updated`) lists it on the Dash's Integrations page. */
export function pebble(): Integration {
  return {
    routingSlug: "pebble",
    async fetch(request, host) {
      using itx = host.getItx();
      return await receive(request, itx);
    },
    async processEvent({ event, itx }) {
      if (event.type !== WORKER_UPDATED) return;
      const signing = (await itx.secrets.list()).some((secret) => secret.path === SIGNING_SECRET);
      // The platform retries an event, so this card may have landed already, perhaps with what was
      // true then (IDEMPOTENCY_CONFLICT): not an error, and the next publish registers it again.
      await itx
        .cd("/integrations")
        .append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `pebble:registry:${event.path}@${event.offset}`,
          payload: { integration: "pebble", card: cardOf(signing) },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
        });
    },
  };
}

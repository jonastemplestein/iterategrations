import { servePage } from "./page.js";

/** The project, as this package uses it: what a config worker's `itx` already has. */
export type VoiceNotesItx = {
  secrets: {
    list(): Promise<{ path: string }[]>;
    verifyEquals(path: string, input: { value: string; field?: string }): Promise<boolean>;
  };
  files: {
    get(path: string): {
      put(input: {
        contentType?: string;
        data: Uint8Array | ArrayBuffer | string;
      }): Promise<unknown>;
      bytes(): Promise<Uint8Array>;
    };
  };
  ai: { run(model: string, body: unknown): Promise<unknown> };
  kv: { get(key: string): Promise<unknown> };
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
  getItx(): VoiceNotesItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: VoiceNotesItx }): Promise<void>;
};

export type IphoneVoiceNotesOptions = {
  /** The routing slug the receiver answers: `iphone-voice-notes` when omitted. */
  slug?: string;
  /** A kv key whose text primes Whisper with names it would otherwise mishear. */
  vocabularyKey?: string;
};

const TOKEN_SECRET = "/secrets/iphone-voice-notes";
/** The header the shortcut sends the token in. Not `Authorization`: a project's host answers
 *  bearer tokens itself, before the project's code runs. */
const TOKEN_HEADER = "x-voice-note-token";
/** `true` marks a note as a test: stored and transcribed like any other, and flagged so a consumer
 *  can skip it. */
const TEST_HEADER = "x-voice-note-test";
/** About an hour of iPhone speech at "Normal" quality. */
const MAX_BYTES = 25 * 1024 * 1024;
const MODEL = "@cf/openai/whisper-large-v3-turbo";

const STREAM = "/iphone-voice-notes";
const RECEIVED = "iphone-voice-notes/recording-received";
const TRANSCRIBED = "iphone-voice-notes/recording-transcribed";

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

const TITLE = "iPhone voice notes";
const DESCRIPTION =
  "Hold the iPhone's Action Button and speak: each recording lands as an audio file and, transcribed, as an iphone-voice-notes/recording-transcribed event on /iphone-voice-notes.";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/iphone-voice-notes";

/** The audio formats a shortcut may send, by content type; anything else is taken for the M4A
 *  that the Record Audio action makes. */
const EXTENSIONS: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

/** The card on the Dash's Integrations page (iterate/integrations): "ok" once the token exists. */
const cardOf = (slug: string, saved: boolean) => ({
  title: TITLE,
  description: DESCRIPTION,
  icon: "https://www.google.com/s2/favicons?domain=apple.com&sz=64",
  status: saved
    ? { kind: "ok" }
    : { kind: "attention", text: "Set up by your coding agent: see the recipe" },
  actions: [
    { label: "Open", routingSlug: slug, path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

const hasToken = async (itx: VoiceNotesItx): Promise<boolean> =>
  (await itx.secrets.list()).some((secret) => secret.path === TOKEN_SECRET);

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

/** An append the platform may already hold: the same key for another payload is a retry of what
 *  landed (IDEMPOTENCY_CONFLICT), not an error. */
const appendOnce = async (
  itx: VoiceNotesItx,
  event: { type: string; idempotencyKey: string; payload: Record<string, unknown> },
): Promise<void> => {
  await itx
    .cd(STREAM)
    .append(event)
    .catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
    });
};

/** The shortcut's upload: the raw audio as the body, the token in its header. Stores the audio as
 *  /iphone-voice-notes/<recordingId>.<ext> and appends `recording-received`, then answers at once;
 *  the transcript follows as its own event. The recording's id is its bytes' hash, so the same
 *  upload again is the same note. */
async function receive(request: Request, itx: VoiceNotesItx): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const token = request.headers.get(TOKEN_HEADER);
  if (!token || !(await itx.secrets.verifyEquals(TOKEN_SECRET, { value: token })))
    return new Response("unauthorized\n", { status: 401 });
  if (Number(request.headers.get("content-length")) > MAX_BYTES)
    return new Response("too large\n", { status: 413 });
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.length === 0) return new Response("no audio in the body\n", { status: 400 });
  if (audio.length > MAX_BYTES) return new Response("too large\n", { status: 413 });

  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = EXTENSIONS[type] ?? "m4a";
  const contentType = EXTENSIONS[type] ? type : "audio/mp4";
  const recordingId = hex(await crypto.subtle.digest("SHA-256", audio)).slice(0, 32);
  const audioPath = `${STREAM}/${recordingId}.${extension}`;
  await itx.files.get(audioPath).put({ contentType, data: audio });
  await appendOnce(itx, {
    type: RECEIVED,
    idempotencyKey: `iphone-voice-notes:${recordingId}`,
    payload: {
      recordingId,
      receivedAt: new Date().toISOString(),
      audioPath,
      contentType,
      bytes: audio.length,
      test: request.headers.get(TEST_HEADER) === "true",
    },
  });
  return Response.json({ ok: true, recordingId });
}

/** A received recording, transcribed with Whisper on Workers AI: `recording-transcribed`, once.
 *  A failed transcription lands too, with a null transcript and the error, so a consumer can
 *  still reach the audio. */
async function transcribe(
  itx: VoiceNotesItx,
  payload: Record<string, unknown>,
  vocabularyKey: string | undefined,
): Promise<void> {
  const { recordingId, receivedAt, audioPath, test } = payload;
  if (typeof recordingId !== "string" || typeof audioPath !== "string") return;
  let transcript: string | null = null;
  let error: string | null = null;
  try {
    const vocabulary = vocabularyKey ? await itx.kv.get(vocabularyKey) : undefined;
    const audio = await itx.files.get(audioPath).bytes();
    const result = (await itx.ai.run(MODEL, {
      audio: base64(audio),
      task: "transcribe",
      ...(typeof vocabulary === "string" && vocabulary ? { initial_prompt: vocabulary } : {}),
    })) as { text?: unknown } | null;
    transcript = typeof result?.text === "string" ? result.text.trim() : null;
    if (transcript === null) error = "Whisper answered no text";
  } catch (caught) {
    error = String(caught).slice(0, 500);
  }
  await appendOnce(itx, {
    type: TRANSCRIBED,
    idempotencyKey: `iphone-voice-notes:transcribed:${recordingId}`,
    payload: { recordingId, receivedAt, audioPath, transcript, model: MODEL, error, test: !!test },
  });
}

/** A project's iPhone voice-note receiver, as an integration its worker hosts:
 *  `const integrations: Integration[] = [iphoneVoiceNotes()];`
 *
 *  On its routing slug it answers the shortcut's uploads at `/webhook` and, for members only, its
 *  page at `/`; any other path is a 404. Its hook transcribes each recording, and its install hook
 *  (`project/worker-updated`) lists it on the Dash's Integrations page. */
export function iphoneVoiceNotes(options: IphoneVoiceNotesOptions = {}): Integration {
  const slug = options.slug ?? "iphone-voice-notes";
  return {
    routingSlug: slug,
    async fetch(request, host) {
      const { pathname } = new URL(request.url);
      if (pathname === "/webhook") {
        using itx = host.getItx();
        return await receive(request, itx);
      }
      const denied = host.auth.require(request);
      if (denied) return denied;
      if (request.method !== "GET" || pathname !== "/")
        return new Response("Not found\n", { status: 404 });
      using itx = host.getItx();
      return servePage(request, {
        title: TITLE,
        description: DESCRIPTION,
        recipe: RECIPE,
        secret: TOKEN_SECRET,
        header: TOKEN_HEADER,
        saved: await hasToken(itx),
      });
    },
    async processEvent({ event, itx }) {
      if (event.type === RECEIVED && event.path === STREAM) {
        await transcribe(
          itx,
          (event.payload ?? {}) as Record<string, unknown>,
          options.vocabularyKey,
        );
        return;
      }
      if (event.type !== WORKER_UPDATED) return;
      // The platform retries an event, so this card may have landed already, perhaps with what was
      // true then (IDEMPOTENCY_CONFLICT): not an error, and the next publish registers it again.
      await itx
        .cd("/integrations")
        .append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `iphone-voice-notes:registry:${event.path}@${event.offset}`,
          payload: { integration: "iphone-voice-notes", card: cardOf(slug, await hasToken(itx)) },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
        });
    },
  };
}

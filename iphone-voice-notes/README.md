# iPhone voice notes

Hold the iPhone's Action Button, speak, tap stop: the recording lands in an iterate project. The
audio becomes the file `/iphone-voice-notes/<recordingId>.m4a` and an
`iphone-voice-notes/recording-received` event on the `/iphone-voice-notes` stream, and a moment
later Whisper's transcript follows as `iphone-voice-notes/recording-transcribed`. No app to install,
and no Face ID: a shortcut does it from the lock screen.

It needs an iPhone with an Action Button (iPhone 15 Pro and later, and every iPhone 16 and later).
On another iPhone the same shortcut runs from **Back Tap** (Settings → Accessibility → Touch →
Back Tap), a Home Screen icon, or Siri ("Voice Note").

The receiver is the package `iterate-iphone-voice-notes`: one element, `iphoneVoiceNotes()`, in the
`integrations` array of the project's config worker. It has a page of its own, for the project's
members: the status with a button to set the token, every step of the shortcut with the URL and
header to copy, and the five newest notes. The project's Integrations page
in the Dash shows an iPhone voice notes card ("Open it to set the token" until the token exists),
with an **Open** button to the page and a **Recipe** button to this recipe.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 1. The token (the person makes it up)

The package's page (step 3) can do this step too: its **Set the token** button opens the same
form, and **Change the token** replaces it later.

The shortcut proves itself with a token in a header, and the project compares it with a secret.
Nobody hands it out: the person invents it, and it has to be the same in the project and in the
shortcut. Best is a password manager that syncs to the phone; tell them:

> Make a new random password of 32+ characters in your password manager (one that syncs to your
> iPhone), or run `openssl rand -hex 32`. You'll paste it into a web page I'm about to send you, and
> again into the shortcut on your iPhone in step 4.

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/iphone-voice-notes",
    egress: { urls: ["https://iphone-voice-notes.invalid"] }, // only ever compared, never sent anywhere
    description:
      "The token your iPhone voice-note shortcut sends: the same value you'll put in its **X-Voice-Note-Token** header.",
  });
```

Send them the returned `url`, tell them to paste the token there, and wait until they say it is
saved. Check that `(await itx.secrets.list()).map((s) => s.path)` includes
`/secrets/iphone-voice-notes`.

## 2. Add the receiver to the project's config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values:

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-iphone-voice-notes";
const IMPORT = 'import { iphoneVoiceNotes } from "iterate-iphone-voice-notes";';
const ELEMENT = "iphoneVoiceNotes()";
const MEMBER = "";
const FILES = {};
```

`iphoneVoiceNotes()` answers the project's `iphone-voice-notes` host (`{ slug }` names another).
`/webhook` takes the shortcut's uploads; the page at `/` is for members. Its hook transcribes each
recording with `@cf/openai/whisper-large-v3-turbo` on Workers AI (no key needed). Whisper mishears
names: `iphoneVoiceNotes({ vocabularyKey: "household/vocabulary" })` primes it with the text kept
at that kv key ("Priya, Tomasz, Oakfield Road, …").

## 3. Send the person to the page

```js
async (itx) => {
  const page = await itx.url({ routingSlug: "iphone-voice-notes", path: "/" });
  const webhook = await itx.url({ routingSlug: "iphone-voice-notes", path: "/webhook" });
  const res = await itx.fetch(new Request(webhook, { method: "POST" }));
  return { page, webhook, status: res.status }; // 401: the receiver refused a request with no token. 404: not published yet
};
```

## 4. Make the shortcut

Give the person these taps, on the iPhone:

1. **Shortcuts** app, **+** at the top right. Name it **Voice Note**.
2. Add **Record Audio**. Expand it: **Audio Quality** Normal, **Start Recording** Immediately,
   **Finish Recording** On Tap.
3. Add **Get Contents of URL**. URL: the webhook URL from the page (its **Copy** button). Expand it:
   - **Method:** POST
   - **Headers:** one, `X-Voice-Note-Token`, with the token from step 1. No `Content-Type` is
     needed: without one, the receiver takes the body for M4A. Not `Authorization`: the project's
     host answers bearer tokens itself, before the receiver sees them.
   - **Request Body:** File, and choose the **Recorded Audio** variable.
4. Optional: add **Vibrate Device** at the end. It buzzes once the upload is in; a failed upload
   shows an error banner instead.
5. Run it once from the editor (the play button) while unlocked, and choose **Always Allow** for
   the microphone and for the project's domain. Otherwise those prompts come up on the lock screen
   later and stop the shortcut.
6. **Settings → Action Button**, swipe to **Shortcut**, **Choose a Shortcut**, **Voice Note**.

To try it without the note counting, add a header `X-Voice-Note-Test: true`: the note is stored and
transcribed as usual, with `test: true` on both events, and a consumer skips it.

iOS does not tell a shortcut when the button is released, so a note ends with a tap on the screen
(or a fixed length: **Finish Recording** After Time). Say so.

## 5. Hand each note to an agent

The package puts notes on `/iphone-voice-notes` and hands them to no one. For an agent to act on
each one, add this to the project's own `processEvent` in `worker.ts`, beside its other cases (it
returns nothing, so the packages' hooks still run), and commit it as any change to the config repo. Name the agent that should get them
(`await itx.agents.list()` lists them):

```ts
const note = (event.payload ?? {}) as Record<string, any>;
// a test note, or one with nothing said, is no input
if (
  event.type === "iphone-voice-notes/recording-transcribed" &&
  !note.test &&
  note.transcript !== ""
)
  await itx.cd("/agents/assistant").append({
    type: "events.iterate.com/agent/context-added",
    // a retried event appends nothing twice
    idempotencyKey: `voice-note:${event.path}@${event.offset}`,
    payload: {
      role: "user",
      content:
        note.transcript === null
          ? `[voice note · ${note.receivedAt}] Not transcribed (${note.error}): transcribe the audio at ${note.audioPath}`
          : `[voice note · ${note.receivedAt}] Said into the iPhone:\n${note.transcript}\n(audio: ${note.audioPath})`,
    },
  });
```

The agent reads the note on its next turn, and the append wakes it for one. A project that routes
inputs already (a chief of staff, a triage gate) gives notes the same path as its other messages.

## 6. Prove it

Ask for a note from the lock screen (hold the Action Button until it buzzes, speak, tap stop), then:

```js
async (itx) => {
  const { payload } = await itx.cd("/iphone-voice-notes").waitForEvent({
    type: "iphone-voice-notes/recording-transcribed",
    timeoutMs: 110_000,
  });
  return payload;
};
```

## The events

On `/iphone-voice-notes`, each once per recording (the id is the audio's SHA-256, so the same
upload again is the same note):

- `iphone-voice-notes/recording-received`:
  `{ recordingId, receivedAt, audioPath, contentType, bytes, test }`, appended before the shortcut
  gets its `200`.
- `iphone-voice-notes/recording-transcribed`:
  `{ recordingId, receivedAt, audioPath, transcript, model, error, test }`. A failed transcription
  lands too, with `transcript: null` and the `error`: the audio is still at `audioPath`.

The body is the raw audio, no multipart: M4A (AAC) from Record Audio, which an iPhone sends as
`audio/x-m4a` (about 110 KB for a short sentence; 0.25 to 0.5 MB a minute). The transcript follows
two to six seconds after the upload; other types keep their own extension (`audio/mpeg`, `.mp3`), and anything that is not
audio is taken for M4A. A body over 25 MiB is refused with `413`.

## Removing it

Delete the shortcut (and the Action Button's choice) on the iPhone, take `iphoneVoiceNotes()` and its
import out of `worker.ts`, and delete `/secrets/iphone-voice-notes`. Once that commit is live, take
the card off with its null:
`itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "iphone-voice-notes", card: null } })`.
The recordings stay on `/iphone-voice-notes` and in the project's files.

# Pebble Index 01

Every recording you make with the ring lands in an iterate project: the transcript as a
`pebble/recording-created` event on the `/pebble` stream, the audio as the file
`/pebble/<recordingId>.m4a`.

## 0. Before you start: the ring and the app

Ask the person which of these is not done yet, and walk them through it:

1. **Install the Pebble app** (the ring's own app, from Core Devices/Pebble): App Store for iPhone,
   or Google Play for Android (package `coredevices.coreapp`).
2. **Pair the Index 01 ring** with the phone by following the app's onboarding, and check a
   recording works: hold the ring's button, talk, and see the recording and its transcript appear
   in the app. If that doesn't work, the webhook can't work either.
3. **Know the two gestures.** _Hold & talk_ (single click, then hold) and _Double click & hold_ are
   the two ways to record, and each has its own webhook settings. Decide which one should reach
   iterate; step 4 configures one or both.

The webhook is in the app under **Index 01 Settings → Webhook** (Pebble's own reference:
[INDEX_WEBHOOK_API.md](https://github.com/coredevices/mobileapp/blob/main/experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/INDEX_WEBHOOK_API.md);
help article: <https://help.repebble.com/en/articles/15724406-index-advanced-features-mcp-webhook>).
It sends every recording of that gesture to a URL of the person's choice, so nothing in this recipe
needs a Pebble account, key or approval. Nothing is configured there until step 4.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 1. The signing secret (the person makes it up)

Nobody hands out this secret: the person invents it, and it only has to be the same in two places,
iterate and the Pebble app's **Sign requests** field. The Pebble app uses it to sign each
recording, and the project uses it to check the signature. A random one is best; tell them:

> Open a terminal and run `openssl rand -hex 32`. That output is your signing secret. Keep it
> handy: you'll paste it into a web page I'm about to send you, and again into the Pebble app in
> step 4. (No terminal? Any 32+ random characters from a password manager work.)

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/pebble-webhook",
    egress: { urls: ["https://pebble.invalid"] }, // only ever compared, never sent anywhere
    description:
      "The signing secret for your Pebble Index webhook: the same value you'll type into the Pebble app's **Sign requests** field.",
  });
```

Send them the returned `url`, tell them to paste the secret there, and wait until they say it is
saved. Check that `(await itx.secrets.list()).map((s) => s.path)` includes `/secrets/pebble-webhook`.

## 2. Add the receiver to the project's config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and one branch to
`worker.ts`, probes the result as a worker, and commits it:

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-pebble";
const SLUG = "pebble";
const IMPORT = 'import { receivePebbleRecording } from "iterate-pebble";';
const BRANCH = `if (request.headers.get("x-iterate-routing-slug") === "pebble")
  return receivePebbleRecording(request, async <T>(call: (itx: any) => T): Promise<Awaited<T>> => {
    using itx = this.getItx();
    return await call(itx);
  });`;
const MEMBER = "";
const FILES = {};
```

The branch answers the project's `pebble` host. `receivePebbleRecording` takes the request and a
function that hands it the project's `itx` for one call (`using` releases it when the block ends).

### By hand, or copy the source

By hand: [add-to-a-project.md](../add-to-a-project.md#by-hand), with the import and the branch above.
To copy the source instead, read [`src/pebble.ts`](src/pebble.ts) (71 lines, no dependencies) and
commit it to `/repos/config` as `pebble.ts`; the branch then imports `receivePebbleRecording` from
`"./pebble.ts"`. You own the copy, so you can change it.

## 3. Get the webhook URL

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "pebble" });
  const res = await itx.fetch(new Request(url, { method: "POST" }));
  return { url, status: res.status }; // 400: the receiver refused an unsigned request. 404: not published yet
};
```

## 4. Point the Pebble app at the project

Give the person the webhook URL from step 3 and these taps, in the Pebble app:

1. **Index 01 Settings → Webhook.**
2. Pick the gesture to configure (**Hold & talk** or **Double click & hold**). Each has its own
   URL, headers and payload.
3. **Webhook URL:** paste the URL from step 3.
4. Turn on **Sign requests** and paste the signing secret from step 1 (the same value, exactly).
5. **Send:** choose **Both**, so you get the transcript and the audio ("Recording only" has no
   transcript; "Transcription only" has no audio file).
6. Tap **Send test event.** Under **Recent runs** it should show as delivered. The project answers
   a verified test event with `200` and stores nothing.
7. **Save.** A gesture only sends once it is saved with a URL. Repeat for the other gesture if they
   want both.

Don't add an `Authorization` header: a project's host answers bearer tokens itself, before the
project's code runs. If the test event fails: the secret differs between the two places (set it
again in both), or the phone's clock is more than five minutes off.

## 5. Prove it

Ask for a recording, then:

```js
async (itx) => {
  const { payload } = await itx.cd("/pebble").waitForEvent({
    type: "pebble/recording-created",
    timeoutMs: 110_000,
  });
  return {
    payload,
    download: payload.audioPath && (await itx.files.get(payload.audioPath).url()).url,
  };
};
```

## The event

`{ deliveryId, trigger, recordedAt, transcript, audioPath }`, idempotent per delivery.
`transcript` and `audioPath` are `null` when the app's mode leaves that part out. The transcript is
Pebble's; iterate transcribes nothing. Requests are verified with the app's signature
(`itx.secrets.verifyHmac`, 5-minute window); the contract is Pebble's
[INDEX_WEBHOOK_API.md](https://github.com/coredevices/mobileapp/blob/main/experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/INDEX_WEBHOOK_API.md).
The whole request is held in memory to verify it: fine for spoken notes.

# Pebble Index 01

Every recording you make with the ring lands in an iterate project: the transcript as a
`pebble/recording-created` event on the `/pebble` stream, the audio as the file
`/pebble/<recordingId>.m4a`.

The receiver is the package `iterate-pebble`: one element, `pebble()`, in the `integrations` array
of the project's config worker. It has a page of its own, for the project's members: the status and
the webhook URL to paste in the Pebble app. The project's Integrations page in the Dash shows a
Pebble card ("Set up by your coding agent" until the signing secret exists), with an **Open** button
to the page and a **Recipe** button to this recipe.

A project with more than one ring hosts one receiver per ring, each with its own names: see
[Several rings](#several-rings-a-receiver-each). The steps below set up the default receiver,
`pebble()`.

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
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `pebble()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it:

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-pebble";
const IMPORT = 'import { pebble } from "iterate-pebble";';
const ELEMENT = "pebble()";
const MEMBER = "";
const FILES = {};
```

`pebble()` answers the project's `pebble` host: the worker hands it every request there, and every
event. `/webhook` takes the Pebble app's recordings. The page at `/` is for the project's members:
it shows the status (whether the signing secret exists) and the webhook URL to paste, with a
**Copy** button. Its install hook (`project/worker-updated`) puts the Pebble card on the Dash.

### By hand, or copy the source

By hand: [add-to-a-project.md](../add-to-a-project.md#by-hand), with the import and the element above.
To copy the source instead, read [`src/pebble.ts`](src/pebble.ts) and [`src/page.ts`](src/page.ts)
(no dependencies) and commit them to `/repos/config` under `pebble/`; the import then reads
`from "./pebble/pebble.ts"`. You own the copy, so you can change it.

## 3. Send the person to the page

```js
async (itx) => {
  const page = await itx.url({ routingSlug: "pebble", path: "/" });
  const webhook = await itx.url({ routingSlug: "pebble", path: "/webhook" });
  const res = await itx.fetch(new Request(webhook, { method: "POST" }));
  return { page, status: res.status }; // 400: the receiver refused an unsigned request. 404: not published yet
};
```

Say: "Open this and sign in. It shows the webhook URL for the Pebble app, with a **Copy** button."
The page says "Set up" once the signing secret from step 1 exists.

## 4. Point the Pebble app at the project

Give the person these taps, in the Pebble app:

1. **Index 01 Settings → Webhook.**
2. Pick the gesture to configure (**Hold & talk** or **Double click & hold**). Each has its own
   URL, headers and payload.
3. **Webhook URL:** paste the URL the page shows (its **Copy** button).
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

## Several rings: a receiver each

Each ring (or each person) gets a receiver of its own: another element of the `integrations` array,
with its own routing slug. Every other name follows from the slug unless you give it:

| Option          | Default                                                           | What it is                                          |
| --------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `slug`          | `pebble`                                                          | The routing slug: the host the app posts to.        |
| `signingSecret` | `/secrets/<slug>-webhook`                                         | The secret the receiver checks signatures with.     |
| `stream`        | `/<slug>`                                                         | The stream its `pebble/recording-created` lands on. |
| `audioDir`      | the `stream` path                                                 | The project-file folder its audio goes in.          |
| `integration`   | the slug                                                          | Its card's key on the Dash's Integrations page.     |
| `title`         | `Pebble Index 01`, or `Pebble Index 01 (<integration>)` otherwise | Its card's and its page's title.                    |

```ts
const integrations: Integration[] = [
  pebble({ slug: "pebble-ada" }), // /secrets/pebble-ada-webhook, /pebble-ada, its own card
  pebble({ slug: "pebble-sam" }), // /secrets/pebble-sam-webhook, /pebble-sam, its own card
];
```

Each receiver checks only its own secret, writes only to its own stream and folder, keys its events
by its own `integration` (`<integration>:<deliveryId>`), and registers its own card. Its names come
from `worker.ts` alone: no request (its host, its headers) can make one receiver act as another.
Give every receiver its own slug, secret, stream and integration; two that share one also share
what it holds. `pebble()` throws on a name it cannot use, so the probe in
[add-to-a-project.md](../add-to-a-project.md) refuses the commit.

The recipe is the same for each receiver, with its names: step 1 collects its `signingSecret`, step 3
asks `itx.url` for its `slug`, and step 5 waits on its `stream`. Its page shows its own webhook URL.
In step 2, `ELEMENT` may list several receivers (`'pebble({ slug: "pebble-ada" }), pebble({ slug:
"pebble-sam" })'`). If `worker.ts` already lists `pebble(…)`, the script only pins the newer package
(the options need it) and leaves the array alone: add the new element by hand next to the first, as
[add-to-a-project.md](../add-to-a-project.md#by-hand) says, and commit it with the tip you read as
`parent`.

**Audio files.** A receiver with options names each file by its bytes:
`<audioDir>/<sha256 of the audio>.m4a`. A path then only ever holds the bytes it was named for, so
neither a redelivery with other audio nor another recording with the same name replaces a file it
accepted. A delivery id that landed before with another recording is answered `409`, and the first
recording stands; the other audio may stay behind as a file that no event names. `pebble()` with no
options keeps the name the app gives the part, `/pebble/<recordingId>.m4a`, as it always has: there a
later delivery with the same name replaces the file. A project that wants the byte names for its one
receiver can write `pebble({ slug: "pebble" })`: the same host, secret, stream and card, with new
files named by their bytes.

## The event

`{ deliveryId, trigger, recordedAt, transcript, audioPath }`, idempotent per delivery.
`transcript` and `audioPath` are `null` when the app's mode leaves that part out. The transcript is
Pebble's; iterate transcribes nothing. Requests are verified with the app's signature
(`itx.secrets.verifyHmac`, 5-minute window); the contract is Pebble's
[INDEX_WEBHOOK_API.md](https://github.com/coredevices/mobileapp/blob/main/experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/INDEX_WEBHOOK_API.md).
The whole request is held in memory to verify it: fine for spoken notes. A body that is not the
app's multipart form (another content type or boundary, or no `recordedAt`) is `400`; a click
gesture's JSON button event is one of those.

**`trigger` is the app's own string, verbatim.** The signature covers it, so nobody without the
secret can change a recording's gesture. The app's recordings carry `single-click-hold` (_Hold &
talk_) or `double-click-hold` (_Double click & hold_). A consumer that acts on the gesture compares
`trigger` with exact strings it knows and treats every other value as unknown: no substring match,
no prefix, no default branch that maps an unknown gesture to an action. A future gesture then does
nothing until the consumer adds it.

## Removing it

Delete the webhook in the Pebble app (Index 01 Settings, Webhook), take `pebble()` and its import out
of `worker.ts`, and delete `/secrets/pebble-webhook` (a receiver with options: its own element, its
`signingSecret`, and its card by its `integration`). The Dash takes nothing away itself, so once
that commit is live, take the card off with its null:
`itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "pebble", card: null } })`. The recordings stay on `/pebble`
and in the project's files.

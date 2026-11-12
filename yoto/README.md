# Yoto

Give an iterate mind's agents the person's [Yoto](https://yoto.com) players and library: list
players, play a card, set the volume and its limit, build a playlist from audio files, upload
cover art. The mind signs in to Yoto itself and calls Yoto's API directly: no server stands between.
Nothing to receive and no package: Yoto has no webhooks (live player status is MQTT, which this
recipe does not do). The recipe is the sign-in and one file, [`yoto.ts`](yoto.ts), that the mind's
config repo gets a copy of.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
mind's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 0. Before you start: a Yoto developer client

The person needs a Yoto developer client of their own. First get the mind's callback address:

```js
async (itx) => itx.secrets.oauthCallbackUrl();
```

Then tell the person:

1. Open <https://dashboard.yoto.dev/> and sign in with their Yoto account.
2. Create a **public** client (one with no client secret; the sign-in is protected by PKCE). Name it
   after the mind. Its one allowed callback URL is the address above.
3. Send you the **Client ID**. It is not a secret.

One client per mind: a client shared with another app can sign this one out.

## 1. Sign in

```js
async (itx) =>
  itx.secrets.beginOAuth("/secrets/yoto", {
    authorizationEndpoint: "https://login.yotoplay.com/authorize",
    tokenEndpoint: "https://login.yotoplay.com/oauth/token",
    clientId: "<the Client ID>",
    clientAuth: "none",
    scope:
      "family:library:view user:content:manage family:devices:view family:devices:control family:devices:manage offline_access",
    extra: { audience: "https://api.yotoplay.com" },
    urls: ["https://login.yotoplay.com", "https://api.yotoplay.com"],
  });
```

It returns `{ authorizationUrl }`. Send the person the link on a line of its own, and tell them:
open it, press Continue, sign in to Yoto and approve; the last page says **Done**. The link lasts
an hour. When they say it is done, `/secrets/yoto` holds the sign-in, and the platform refreshes it.

- Drop `family:devices:control` and `family:devices:manage` for a read-only connection; playback
  and volume then fail.
- Without `offline_access` Yoto gives no refresh token, and the sign-in ends when its first token
  does.
- `audience` names the API the token is for: Yoto's API takes only a token issued for it.

## 2. Add `yoto.ts` to the mind's config repo

[`yoto.ts`](yoto.ts) has one function, `yoto(itx, tool, args)`: each tool below is one or two
requests to `https://api.yotoplay.com`. It imports nothing. This script copies it into
`/repos/config`, adds a method `yoto(tool, args)` to the worker's class so that every agent reaches
it as `itx.config.yoto(…)`, probes the result as a worker, and commits:

```js
async (itx) => {
  const source = await (
    await itx.fetch(
      new Request(
        "https://raw.githubusercontent.com/jonastemplestein/iterategrations/main/yoto/yoto.ts",
      ),
    )
  ).text();
  if (!source.includes("export async function yoto(")) throw new Error("yoto.ts did not arrive");
  const repo = itx.repos.get("/repos/config");
  const tip = await repo.tip();
  let worker = await repo.readFile("worker.ts", { commitOid: tip });
  if (worker.includes('from "./yoto.ts"')) return { already: true };
  const classAt = worker.search(/export default class[^{]*\{/);
  if (classAt < 0) throw new Error("worker.ts has no default export class");
  const bodyAt = worker.indexOf("{", classAt) + 1;
  const member = `
  /** Yoto, by the tool names of the recipe: \`await itx.config.yoto("list_players")\`. */
  async yoto(tool: string, args: Record<string, unknown> = {}) {
    using itx = this.getItx();
    return await yoto(itx, tool, args);
  }
`;
  worker =
    'import { yoto } from "./yoto.ts";\n' + worker.slice(0, bodyAt) + member + worker.slice(bodyAt);
  const files = { "yoto.ts": source, "worker.ts": worker };
  // probe before the commit: a published worker that fails takes every host of the mind down
  const probe = await itx.workers
    .get({ source: { ...(await repo.modules({ commitOid: tip })), ...files } })
    .fetch(new Request("https://probe.invalid/"));
  if (probe.status >= 500)
    throw new Error(`the patched worker answers ${probe.status}: nothing committed`);
  const { commitOid } = await repo.commitFiles({
    message: "Add yoto.ts: Yoto's API for the mind's agents. Via: <your name>",
    parent: tip,
    changes: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  const outcome = await itx.waitForEvent({
    type: [
      "events.iterate.com/mind/worker-updated",
      "events.iterate.com/mind/worker-update-failed",
    ],
    payload: { commitOid },
    afterOffset: 0,
    timeoutMs: 120000,
  });
  return { commitOid, outcome: outcome.type, error: outcome.payload?.error };
};
```

You own the copy. To take a later version of the file, commit it over yours.

## 3. Prove it

Read-only, and it shows the person's real players:

```js
async (itx) => itx.config.yoto("list_players");
```

Players back is the proof. A few seconds after the commit the method may not answer yet: try again.
Then write the connection down for the mind's agents: the players' names and ids, and the tools.

## What the tools do

`list_players`, `get_player_config`, `list_library`, `get_library_card`, `list_myo_cards`,
`get_card`, `list_library_groups`, `get_library_group`, `create_streaming_card`, `play_card`,
`pause_playback`, `resume_playback`, `stop_playback`, `set_volume`, `set_sleep_timer`,
`update_player_config`, `set_volume_limit`, and, for making content, `upload_audio`,
`prepare_audio_upload`, `get_audio_upload`, `add_audio_to_card`, `get_playlist`, `create_playlist`,
`update_playlist`, `upload_cover_image`, `set_card_cover`, `list_icons`, `upload_icon`. Each `case`
in [`yoto.ts`](yoto.ts) shows a tool's arguments and the request it sends.

For something no tool covers, call the API with the secret's placeholder:

```js
async (itx) =>
  (
    await itx.fetch(
      new Request("https://api.yotoplay.com/device-v2/devices/mine", {
        headers: { authorization: 'Bearer getSecret("/secrets/yoto", { field: "accessToken" })' },
      }),
    )
  ).json();
```

- Commands report that Yoto _accepted_ them, not that the player did them.
- `set_volume` is a percentage (0–100) of the current playback; `set_volume_limit` is 0–16 steps.
- Audio and images come in as public HTTPS URLs, up to 20 MiB and 5 MiB. A mind file works: mint
  a link with `itx.files.get(path).url()` (valid for a week) and pass it as the URL.
- Streaming cards need internet on the player during playback.
- The sign-in, the refresh and the reads (players, library, a player's config) were run against a
  real Yoto account in November 2026, and `play_card` earlier. The other playback calls, the
  settings writes and the card-making calls were not: the first real call is the proof. Send what
  it says if it fails.
- If a call answers 401, or the secret's refresh fails with `invalid_grant`, the sign-in has
  lapsed: run step 1 again.
- To remove it: take the method and the import out of `worker.ts`, delete `yoto.ts`, then
  `itx.secrets.delete("/secrets/yoto")`, and delete the client at <https://dashboard.yoto.dev/>.

// yoto.ts: Yoto's own API (https://api.yotoplay.com) for a mind's agents, by tool name. Copy this file into the
// mind's config repo (the recipe's step 2). The sign-in is the secret `/secrets/yoto`: the platform's own OAuth
// sign-in with Yoto, which it refreshes. The code never sees a token: it sends a placeholder, and the platform
// puts the token in as the request leaves. `yoto(itx, tool, args)` answers the tools README.md lists.

/** The mind, as this file uses it: what a config worker's `itx` already has. */
export type YotoItx = { fetch(request: Request): Promise<Response> };

const API = "https://api.yotoplay.com";
const AUTHORIZATION = 'Bearer getSecret("/secrets/yoto", { field: "accessToken" })';
type Args = Record<string, any>;
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error(`yoto: ${JSON.stringify(value)} is no id`);
  return encodeURIComponent(value);
};

async function send(
  itx: YotoItx,
  path: string,
  body?: unknown,
  method?: string,
  contentType = "application/json",
) {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await itx.fetch(
    new Request(API + path, {
      method: verb,
      headers: {
        authorization: AUTHORIZATION,
        ...(body !== undefined && { "content-type": contentType }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array
            ? (body as Uint8Array<ArrayBuffer>)
            : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(`Yoto ${verb} ${path.split("?")[0]}: ${response.status} ${text.slice(0, 300)}`);
  return text.trim() ? JSON.parse(text) : null;
}

/** Yoto answers that it took a command, never that the player carried it out. */
async function command(itx: YotoItx, deviceId: string, name: string, body: unknown = {}) {
  await send(itx, `/device-v2/${id(deviceId)}/command/${name}`, body);
  return {
    accepted: true,
    deviceId,
    command: name,
    message: "Yoto accepted the command. This is not confirmation that the player executed it.",
  };
}

const getConfig = (itx: YotoItx, deviceId: string) =>
  send(itx, `/device-v2/${id(deviceId)}/config`);

async function updateConfig(
  itx: YotoItx,
  deviceId: string,
  name: string | undefined,
  config: Args = {},
) {
  // Yoto keeps every setting as text; only the settings given are sent
  const sent = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      typeof value === "number" ? String(value) : value,
    ]),
  );
  if (!name && Object.keys(sent).length === 0)
    throw new Error("yoto: give a name or at least one setting");
  await send(
    itx,
    `/device-v2/${id(deviceId)}/config`,
    { ...(name && { name }), ...(Object.keys(sent).length > 0 && { config: sent }) },
    "PUT",
  );
  const current = await getConfig(itx, deviceId);
  const verified =
    Object.entries(sent).every(([key, value]) => current?.device?.config?.[key] === value) &&
    (!name || current?.device?.name === name);
  return { accepted: true, verified, deviceId, ...current };
}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : (JSON.stringify(value) ?? "null");
const b64url = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

/** A home-made card and the revision an edit must name: a hash of the card as Yoto holds it now. */
async function getPlaylist(itx: YotoItx, cardId: string) {
  const { card } = await send(itx, `/content/${id(cardId)}`);
  return { card, revision: await sha256(new TextEncoder().encode(canonical(card))) };
}
const save = (itx: YotoItx, body: Args) => send(itx, "/content", body);

/** A file from a direct HTTPS address, for an upload: its bytes and type. */
async function media(url: string, kind: "audio" | "image", limit: number) {
  if (!url.startsWith("https://")) throw new Error("yoto: the media address must be https");
  const response = await fetch(url, { redirect: "manual" });
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!response.ok || !contentType.startsWith(`${kind}/`))
    throw new Error(`yoto: ${url} did not answer ${kind} (${response.status} ${contentType})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > limit)
    throw new Error(`yoto: the ${kind} is empty or over ${limit / 1024 / 1024} MiB`);
  return { bytes, contentType };
}

async function audioStatus(itx: YotoItx, uploadId: string) {
  const answer = await send(itx, `/media/upload/${id(uploadId)}/transcoded?loudnorm=false`).catch(
    (error: Error) => {
      if (/: 404 /.test(error.message)) return undefined;
      throw error;
    },
  );
  const transcode = answer?.transcode;
  if (!transcode?.transcodedSha256) return { uploadId, ready: false as const };
  const info = transcode.transcodedInfo ?? transcode.mediaInfo ?? {};
  return {
    uploadId,
    ready: true as const,
    track: {
      trackUrl: `yoto:#${transcode.transcodedSha256}`,
      type: "audio",
      duration: info.duration,
      fileSize: info.fileSize,
      format: info.format,
    },
  };
}

export async function yoto(itx: YotoItx, tool: string, a: Args = {}): Promise<unknown> {
  switch (tool) {
    case "list_players":
      return send(itx, "/device-v2/devices/mine");
    case "get_player_config":
      return getConfig(itx, a.deviceId);
    case "list_library":
      return send(itx, "/card/family/library?view=groups");
    case "get_library_card":
      return send(
        itx,
        `/card/details/${id(a.cardId)}?timezone=${encodeURIComponent(a.timezone ?? "UTC")}`,
      );
    case "list_myo_cards":
      return send(itx, "/content/mine");
    case "get_card":
      return send(itx, `/content/${id(a.cardId)}`);
    case "get_playlist":
      return getPlaylist(itx, a.cardId);
    case "list_library_groups":
      return send(itx, "/card/family/library/groups");
    case "get_library_group":
      return send(itx, `/card/family/library/groups/${id(a.groupId)}`);
    case "play_card":
      if (a.trackKey && !a.chapterKey) throw new Error("yoto: a track key needs a chapter key");
      return command(itx, a.deviceId, "card-play", {
        uri: `https://yoto.io/${id(a.cardId)}`,
        chapterKey: a.chapterKey,
        trackKey: a.trackKey,
        secondsIn: a.secondsIn ?? 0,
        cutOff: 0,
      });
    case "pause_playback":
      return command(itx, a.deviceId, "card-pause");
    case "resume_playback":
      return command(itx, a.deviceId, "card-resume");
    case "stop_playback":
      return command(itx, a.deviceId, "card-stop");
    case "set_volume":
      return command(itx, a.deviceId, "set-volume", { volume: a.volume });
    case "set_sleep_timer":
      return command(itx, a.deviceId, "sleep", { seconds: a.seconds });
    case "update_player_config":
      return updateConfig(itx, a.deviceId, a.name, a.config);
    case "set_volume_limit": {
      if (!Number.isInteger(a.limit) || a.limit < 0 || a.limit > 16)
        throw new Error("yoto: a volume limit is 0 to 16 steps");
      const period = a.period ?? "both";
      return updateConfig(itx, a.deviceId, undefined, {
        ...(period !== "night" && { maxVolumeLimit: a.limit }),
        ...(period !== "day" && { nightMaxVolumeLimit: a.limit }),
      });
    }
    case "create_streaming_card":
      return save(itx, {
        title: a.title,
        ...(a.description !== undefined && { metadata: { description: a.description } }),
        content: {
          chapters: (a.tracks as Args[]).map((track, index) => ({
            key: String(index + 1).padStart(2, "0"),
            title: track.title,
            overlayLabel: String(index + 1),
            tracks: [
              {
                key: "01",
                title: track.title,
                trackUrl: track.url,
                type: "stream",
                format: track.format,
              },
            ],
          })),
        },
      });
    case "create_playlist":
      return save(itx, {
        title: a.title,
        content: { chapters: a.chapters, ...(a.config && { config: a.config }) },
        ...(a.metadata && { metadata: a.metadata }),
      });
    case "update_playlist": {
      const { card, revision } = await getPlaylist(itx, a.cardId);
      if (revision !== a.expectedRevision)
        throw new Error(
          "yoto: the playlist changed since it was read. Get it again and look at your change.",
        );
      const metadata = {
        ...card.metadata,
        ...a.metadata,
        ...(a.metadata?.cover && { cover: { ...card.metadata?.cover, ...a.metadata.cover } }),
      };
      const content = {
        ...card.content,
        ...(a.chapters && { chapters: a.chapters }),
        ...(a.config && { config: { ...card.content?.config, ...a.config } }),
      };
      return save(itx, { cardId: card.cardId, title: a.title ?? card.title, content, metadata });
    }
    case "prepare_audio_upload":
      return send(
        itx,
        `/media/transcode/audio/uploadUrl?${new URLSearchParams({ sha256: a.sha256, ...(a.filename && { filename: a.filename }) })}`,
      );
    case "upload_audio": {
      const { bytes, contentType } = await media(a.url, "audio", 20 * 1024 * 1024);
      const query = new URLSearchParams({
        sha256: await sha256(bytes),
        ...(a.filename && { filename: a.filename }),
      });
      const { upload } = await send(itx, `/media/transcode/audio/uploadUrl?${query}`);
      if (upload.uploadUrl) {
        // Yoto's signed storage address: no Yoto sign-in goes to it
        const put = await fetch(upload.uploadUrl, {
          method: "PUT",
          headers: { "content-type": contentType },
          body: bytes,
        });
        if (!put.ok)
          throw new Error(
            `yoto: storage refused the upload (${put.status}); look at get_audio_upload for ${upload.uploadId} before you try again`,
          );
      }
      return { uploadId: upload.uploadId, bytes: bytes.length, reused: !upload.uploadUrl };
    }
    case "get_audio_upload":
      return audioStatus(itx, a.uploadId);
    case "add_audio_to_card": {
      const existing = a.cardId ? await getPlaylist(itx, a.cardId) : undefined;
      if (existing && existing.revision !== a.expectedRevision)
        throw new Error(
          "yoto: get the playlist and give its current revision before you add tracks",
        );
      if (!existing && !a.title) throw new Error("yoto: a new playlist needs a title");
      const chapters = [];
      for (const track of a.tracks as Args[]) {
        const status = await audioStatus(itx, track.uploadId);
        if (!status.ready)
          throw new Error(
            `yoto: the audio upload ${track.uploadId} is not ready. No playlist was changed.`,
          );
        chapters.push({
          key: crypto.randomUUID(),
          title: track.title,
          display: { icon16x16: track.icon16x16 ?? null },
          tracks: [{ key: "01", title: track.title, ...status.track }],
        });
      }
      if (!existing) return save(itx, { title: a.title, content: { chapters } });
      const { card } = existing;
      return save(itx, {
        cardId: card.cardId,
        title: card.title,
        content: { ...card.content, chapters: [...card.content.chapters, ...chapters] },
        metadata: card.metadata,
      });
    }
    case "upload_cover_image": {
      const { bytes, contentType } = await media(a.imageUrl, "image", 5 * 1024 * 1024);
      const query = new URLSearchParams({ autoconvert: "true", coverType: a.coverType ?? "myo" });
      return (
        await send(itx, `/media/coverImage/user/me/upload?${query}`, bytes, "POST", contentType)
      ).coverImage;
    }
    case "set_card_cover": {
      const cover = (await yoto(itx, "upload_cover_image", a)) as { mediaUrl: string };
      return yoto(itx, "update_playlist", {
        cardId: a.cardId,
        expectedRevision: a.expectedRevision,
        metadata: { cover: { imageL: cover.mediaUrl } },
      });
    }
    case "list_icons":
      return send(itx, `/media/displayIcons/user/${a.source === "mine" ? "me" : "yoto"}`);
    case "upload_icon": {
      const { bytes, contentType } = await media(a.imageUrl, "image", 5 * 1024 * 1024);
      const query = new URLSearchParams({
        autoConvert: "true",
        ...(a.filename && { filename: a.filename }),
      });
      const { displayIcon } = await send(
        itx,
        `/media/displayIcons/user/me/upload?${query}`,
        bytes,
        "POST",
        contentType,
      );
      return { ...displayIcon, icon16x16: `yoto:#${displayIcon.mediaId}` };
    }
    default:
      throw new Error(`yoto: ${JSON.stringify(tool)} is no tool; the recipe's README lists them`);
  }
}

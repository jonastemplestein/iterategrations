// WHAT THE PROJECT'S OWN CODE NEEDS TO ANSWER IN A CHAT: one Bot API call, a long text in pieces,
// and an agent's answer with files. An agent's run script cannot import a package, so it calls the
// Bot API with plain `fetch` (the README's "Calling Telegram"); a project's `worker.ts` and the
// files it imports can import these. Each call goes with the global `fetch`: in every worker the
// platform loads, the project's egress, which swaps the bot's token in for its placeholder toward
// api.telegram.org and nowhere else. https://core.telegram.org/bots/api
import { call, placeholder, type TelegramItx } from "./bot.js";

/** One Bot API call for `bot`'s token, with the global `fetch`: it posts `params` as JSON to
 *  `https://api.telegram.org/bot<placeholder>/<method>` and answers Telegram's `result`. Throws
 *  `<method>: <description>` when Telegram refuses the call.
 *  `await api("acme-bot", "sendMessage", { chat_id: 42, text: "Hello" })` */
export function api<T = unknown>(
  bot: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  // the global `fetch` as it is at the call
  return call<T>({ fetch: (request) => fetch(request) }, placeholder(bot), method, params);
}

/** A text message holds at most 4096 characters. */
export const MESSAGE_LIMIT = 4096;

/** `text` in pieces of at most `limit` characters, cut at a blank line, a line end or a space where
 *  one is near, and never inside a surrogate pair. */
export function splitText(text: string, limit: number = MESSAGE_LIMIT): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    let cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.lastIndexOf(" "));
    if (cut < limit / 2) cut = limit;
    const last = rest.charCodeAt(cut - 1);
    if (cut === limit && last >= 0xd800 && last <= 0xdbff) cut -= 1; // a high surrogate: keep the pair whole
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest !== "" || pieces.length === 0) pieces.push(rest);
  return pieces;
}

/** The longest words a file carries as its caption (Telegram takes 1,024 characters): longer words
 *  go as a message of their own. */
const CAPTION_MAX_CHARS = 1_000;

/** How Telegram shows a file, by its content type and name:
 *  - `image`: JPEG, PNG or WebP, as a photo (an SVG or a HEIC is a document);
 *  - `video`: MP4 (a WebM or a MOV is a document);
 *  - `voice`: Ogg Opus, as a voice note;
 *  - `audio`: MP3, M4A and the other audio types, in the music player;
 *  - `document`: the rest, which any client can open or save. */
type MediaKind = "image" | "video" | "voice" | "audio" | "document";
function mediaKindOf(contentType: string, fileName: string): MediaKind {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/png" || type === "image/webp") return "image";
  if (type === "video/mp4") return "video";
  if (type === "audio/ogg" || type === "audio/opus" || /\.(ogg|oga|opus)$/i.test(fileName))
    return "voice";
  if (type.startsWith("audio/")) return "audio";
  return "document";
}

/** The method that sends each kind of file, and the parameter that carries it. */
const SENDERS: Record<MediaKind, [method: string, field: string]> = {
  image: ["sendPhoto", "photo"],
  video: ["sendVideo", "video"],
  voice: ["sendVoice", "voice"],
  audio: ["sendAudio", "audio"],
  document: ["sendDocument", "document"],
};

/** An attached file as `sendAnswer` found it: what it is and where Telegram fetches it, or null
 *  when there is no such project file. */
type Attached = {
  path: string;
  caption: string;
  found: { contentType: string; url: string } | null;
};

/** An answer to a Telegram chat. `to` is the bot, the chat and the forum topic in it, if any (a
 *  `telegram/message-accepted` payload's `bot`, `chat.id` and `threadId`). `answer` is the words,
 *  and the project files to attach (`itx.files`), each with a caption of its own.
 *
 *  The words go first, as messages of at most `MESSAGE_LIMIT` characters (`splitText`). Then each
 *  file goes as the photo, video, voice note, audio or document its content type and name say:
 *  Telegram fetches it from a signed URL that lasts ten minutes. One photo, video or document with
 *  words of at most 1,000 characters carries the words as its caption, and no message goes. A
 *  file that does not exist is said in the words. A call that Telegram refuses throws, and what
 *  went before it stays sent. */
export async function sendAnswer(
  itx: Pick<TelegramItx, "files">,
  to: { bot: string; chatId: number; threadId?: number },
  answer: { text: string; files?: { path: string; caption?: string }[] },
): Promise<void> {
  const words = answer.text.trim();
  const base = { chat_id: to.chatId, ...(to.threadId ? { message_thread_id: to.threadId } : {}) };
  const attached: Attached[] = [];
  for (const file of answer.files ?? []) {
    const handle = itx.files.get(file.path);
    const head = await handle.head();
    attached.push({
      path: file.path,
      caption: file.caption ?? "",
      found: head
        ? { contentType: head.contentType, url: (await handle.url({ expiresInSeconds: 600 })).url }
        : null,
    });
  }
  const name = (file: Attached) => file.path.split("/").at(-1)!;
  const kindOf = (file: Attached) => mediaKindOf(file.found!.contentType, name(file));
  const captioned =
    attached.length === 1 &&
    attached[0]!.found !== null &&
    !["voice", "audio"].includes(kindOf(attached[0]!)) &&
    words.length > 0 &&
    words.length <= CAPTION_MAX_CHARS;
  const said = [
    ...(captioned ? [] : [words]),
    ...attached
      .filter((file) => !file.found)
      .map((file) => `(I meant to attach ${file.path}, but there is no such file.)`),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (said) for (const text of splitText(said)) await api(to.bot, "sendMessage", { ...base, text });
  for (const file of attached) {
    if (!file.found) continue;
    const kind = kindOf(file);
    const [method, field] = SENDERS[kind];
    const caption = (captioned ? words : file.caption).slice(0, CAPTION_MAX_CHARS);
    await api(to.bot, method, {
      ...base,
      [field]: file.found.url,
      ...(caption && kind !== "voice" && kind !== "audio" ? { caption } : {}),
    });
  }
}

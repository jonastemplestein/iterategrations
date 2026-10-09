// Runs against dist, the package as shipped. `telegramBehind` puts a pretend Telegram behind the
// global `fetch`, which is the project's egress in a loaded worker: it records each Bot API call
// (the credential in the URL path, the method, the JSON body) and answers ok, or refuses a method
// as Telegram does. `projectFiles` is the project's `itx.files`: the files that exist, with their
// content types, and a signed URL for each, recording the expiry asked for.
import assert from "node:assert/strict";
import { afterEach, test } from "vite-plus/test";
import { api, MESSAGE_LIMIT, placeholder, sendAnswer, splitText } from "../dist/telegram.js";

const BOT = "acme-bot";
const PLACEHOLDER = 'getSecret("/secrets/telegram-acme-bot", { field: "token" })';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { credential: string; method: string; contentType: string | null; body: any };

/** A pretend Telegram behind the global `fetch`: each call recorded and answered ok, or refused
 *  with the description `refuse` names for its method. */
function telegramBehind(refuse: Record<string, string> = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.method, "POST");
    const url = decodeURIComponent(request.url);
    assert.ok(url.startsWith("https://api.telegram.org/bot"), url);
    const rest = url.slice("https://api.telegram.org/bot".length);
    const method = rest.slice(rest.lastIndexOf("/") + 1);
    calls.push({
      credential: rest.slice(0, rest.lastIndexOf("/")),
      method,
      contentType: request.headers.get("content-type"),
      body: JSON.parse(await request.text()),
    });
    if (method in refuse)
      return Response.json(
        { ok: false, error_code: 400, description: refuse[method] },
        { status: 400 },
      );
    return Response.json({ ok: true, result: { message_id: calls.length } });
  }) as typeof fetch;
  return calls;
}

/** The project's files: each path that exists, with its content type. */
function projectFiles(files: Record<string, string>) {
  const expiries: number[] = [];
  const itx = {
    files: {
      get: (path: string) => ({
        head: async () => (path in files ? { path, contentType: files[path]!, size: 1 } : null),
        url: async ({ expiresInSeconds }: { expiresInSeconds: number }) => {
          expiries.push(expiresInSeconds);
          return { url: signed(path), expiresAt: "2026-10-09T12:10:00.000Z" };
        },
      }),
    },
  };
  return { itx, expiries };
}
const signed = (path: string) => `https://files.example${path}?signature=made-up`;
const sent = (calls: Call[]) => calls.map(({ method, body }) => ({ method, body }));

// ------------------------------------------------------------------ splitText

test("splitText keeps a text within the limit whole; an empty text is one empty piece", () => {
  assert.equal(MESSAGE_LIMIT, 4096);
  assert.deepEqual(splitText("hello"), ["hello"]);
  assert.deepEqual(splitText("x".repeat(MESSAGE_LIMIT)), ["x".repeat(MESSAGE_LIMIT)]);
  assert.deepEqual(splitText(""), [""]);
});

test("splitText cuts at the last blank line, line end or space in a piece's second half, and the next piece starts after the white space", () => {
  assert.deepEqual(splitText("aaaa bbbb cccc", 10), ["aaaa bbbb", "cccc"]);
  assert.deepEqual(splitText("aaaaaaaa\nbbbbbbbb", 12), ["aaaaaaaa", "bbbbbbbb"]);
  assert.deepEqual(splitText("aaaaaaaa\n\nbbbbbbbb", 12), ["aaaaaaaa\n", "bbbbbbbb"]);
  // white space only in the first half, or none: a cut at the limit
  assert.deepEqual(splitText("ab cdefghijklmnop", 10), ["ab cdefghi", "jklmnop"]);
  assert.deepEqual(splitText("a".repeat(25), 10), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  // at the default limit every piece fits a message, and only the spaces cut at are gone
  const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
  const pieces = splitText(words);
  assert.ok(pieces.length > 1 && pieces.every((piece) => piece.length <= MESSAGE_LIMIT));
  assert.equal(pieces.join(" "), words);
});

test("splitText never cuts a surrogate pair in two", () => {
  assert.deepEqual(splitText(`a${"😀".repeat(10)}`, 10), ["a😀😀😀😀", "😀😀😀😀😀", "😀"]);
  const text = `a${"😀".repeat(3000)}`;
  const pieces = splitText(text);
  assert.equal(pieces[0]!.length, MESSAGE_LIMIT - 1);
  assert.ok(pieces.every((piece) => !/[\ud800-\udbff]$/.test(piece)));
  assert.equal(pieces.join(""), text);
});

// ------------------------------------------------------------------------ api

test("api calls the Bot API with the global fetch: the bot's placeholder in the URL path, the params as JSON, and Telegram's result answered", async () => {
  const calls = telegramBehind();
  assert.equal(placeholder(BOT), PLACEHOLDER);
  assert.deepEqual(await api(BOT, "sendMessage", { chat_id: 42, text: "Hello" }), {
    message_id: 1,
  });
  await api(BOT, "getMe");
  assert.deepEqual(calls, [
    {
      credential: PLACEHOLDER,
      method: "sendMessage",
      contentType: "application/json",
      body: { chat_id: 42, text: "Hello" },
    },
    { credential: PLACEHOLDER, method: "getMe", contentType: "application/json", body: {} },
  ]);
});

test("a call Telegram refuses throws its method and Telegram's description", async () => {
  telegramBehind({ sendMessage: "Bad Request: chat not found" });
  await assert.rejects(api(BOT, "sendMessage", { chat_id: 7, text: "Hello" }), {
    message: "sendMessage: Bad Request: chat not found",
  });
});

// ----------------------------------------------------------------- sendAnswer

test("sendAnswer sends one photo with short words as its caption, in the chat's topic, from a signed URL that lasts ten minutes", async () => {
  const calls = telegramBehind();
  const { itx, expiries } = projectFiles({ "/plans/sofa.jpg": "image/jpeg" });
  await sendAnswer(
    itx,
    { bot: BOT, chatId: -100, threadId: 9 },
    { text: "The sofa, as delivered.", files: [{ path: "/plans/sofa.jpg", caption: "sofa" }] },
  );
  assert.deepEqual(sent(calls), [
    {
      method: "sendPhoto",
      body: {
        chat_id: -100,
        message_thread_id: 9,
        photo: signed("/plans/sofa.jpg"),
        caption: "The sofa, as delivered.",
      },
    },
  ]);
  assert.equal(calls[0]!.credential, PLACEHOLDER);
  assert.deepEqual(expiries, [600]);
});

test("sendAnswer says a file that does not exist in the words, and sends each file that does as what its type and name say", async () => {
  const calls = telegramBehind();
  const { itx } = projectFiles({
    "/notes/memo.ogg": "audio/ogg",
    "/notes/song.mp3": "audio/mpeg",
    "/notes/clip.mp4": "video/mp4",
    "/notes/plan.pdf": "application/pdf",
    "/notes/logo.svg": "image/svg+xml",
    "/notes/reply.opus": "application/octet-stream",
  });
  await sendAnswer(
    itx,
    { bot: BOT, chatId: 42 },
    {
      text: "Here they are.",
      files: [
        { path: "/notes/missing.pdf", caption: "gone" },
        { path: "/notes/memo.ogg", caption: "a memo" },
        { path: "/notes/song.mp3", caption: "a song" },
        { path: "/notes/clip.mp4", caption: "a clip" },
        { path: "/notes/plan.pdf", caption: "the plan" },
        { path: "/notes/logo.svg" },
        { path: "/notes/reply.opus" },
      ],
    },
  );
  assert.deepEqual(sent(calls), [
    {
      method: "sendMessage",
      body: {
        chat_id: 42,
        text: "Here they are.\n\n(I meant to attach /notes/missing.pdf, but there is no such file.)",
      },
    },
    // a voice note and an audio file go without a caption
    { method: "sendVoice", body: { chat_id: 42, voice: signed("/notes/memo.ogg") } },
    { method: "sendAudio", body: { chat_id: 42, audio: signed("/notes/song.mp3") } },
    {
      method: "sendVideo",
      body: { chat_id: 42, video: signed("/notes/clip.mp4"), caption: "a clip" },
    },
    {
      method: "sendDocument",
      body: { chat_id: 42, document: signed("/notes/plan.pdf"), caption: "the plan" },
    },
    { method: "sendDocument", body: { chat_id: 42, document: signed("/notes/logo.svg") } },
    { method: "sendVoice", body: { chat_id: 42, voice: signed("/notes/reply.opus") } },
  ]);
});

test("sendAnswer sends long words as messages of at most 4096 characters, then the file with its own caption", async () => {
  const calls = telegramBehind();
  const { itx } = projectFiles({ "/plans/floor.png": "image/png" });
  const text = Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n");
  await sendAnswer(
    itx,
    { bot: BOT, chatId: 42 },
    { text, files: [{ path: "/plans/floor.png", caption: "the floor plan" }] },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["sendMessage", "sendMessage", "sendPhoto"],
  );
  const pieces = calls.slice(0, 2).map((call) => call.body.text as string);
  assert.ok(pieces.every((piece) => piece.length <= MESSAGE_LIMIT));
  assert.equal(pieces.join("\n"), text);
  assert.deepEqual(calls[2]!.body, {
    chat_id: 42,
    photo: signed("/plans/floor.png"),
    caption: "the floor plan",
  });
});

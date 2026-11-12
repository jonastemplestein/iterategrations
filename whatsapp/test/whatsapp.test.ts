// whatsapp.test.ts — the lend over the pretend WhatsApp (dummy.ts), with a pretend mind: what the
// mind calls reaches the socket and comes back as JSON, every event of the socket lands as
// whatsapp/<Baileys' name> (a message as one whatsapp/messages.upsert of its own) on the account's
// stream and again on its chat's, media round-trips through downloadMedia, a url that would read
// this computer is refused, and events that could not reach the mind wait for its next connection.
// The same lend through a real deployment is the README's walkthrough.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vite-plus/test";
import provideDummy from "../src/dummy.ts";
import provideWhatsApp, {
  describeLend,
  description,
  lendOnly,
  provideWhatsApp as lendOver,
} from "../src/whatsapp.ts";
import { chatParts, eventPayloads } from "../src/whatsapp.ts";
import type { Itx, WhatsAppEvent } from "../src/whatsapp.ts";

type Lent = Record<string, (...args: any[]) => Promise<any>>;

test("the real lend imports without connecting: a default export and a description", () => {
  assert.equal(typeof provideWhatsApp, "function");
  assert.match(description, /Baileys/);
});

test("the pretend WhatsApp, lent: calls, events, media, refused urls, and messages that wait for the next connection", async () => {
  const mind = pretendMind();
  const lent = (await provideDummy({ itx: mind.itx })) as Lent;
  assert.ok(lent.sendMessage && lent.groupMetadata && lent.downloadMedia && lent.__describe);

  // a send comes back as Baileys' message, as JSON, and lands as an `append`
  const sent = await lent.sendMessage("447700900002@s.whatsapp.net", { text: "hi" });
  assert.deepEqual(sent.key, {
    remoteJid: "447700900002@s.whatsapp.net",
    fromMe: true,
    id: sent.key.id,
  });
  await mind.settled();
  const landed = {
    type: "whatsapp/messages.upsert",
    payload: { event: "messages.upsert", data: { type: "append", messages: [sent] } },
    idempotencyKey: `whatsapp/messages.upsert:447700900002@s.whatsapp.net:${sent.key.id}`,
  };
  assert.deepEqual(mind.events.at(-1), landed);
  // and again on the chat's own stream
  assert.deepEqual(
    mind.streams.get("/integrations/whatsapp-dummy/chats/447700900002@s.whatsapp.net"),
    [landed],
  );

  // a contact's image: the event carries the key as { type: "Buffer" } JSON, downloadMedia the bytes
  await lent.simulateIncomingMessage({
    from: "447700900003@s.whatsapp.net",
    image: { data: new Uint8Array([7, 8, 9]), mimetype: "image/png", caption: "look" },
  });
  await mind.settled();
  const received = mind.events.at(-1)!.payload.data as { type: string; messages: any[] };
  assert.equal(received.type, "notify");
  assert.equal(received.messages[0].message.imageMessage.mediaKey.type, "Buffer");
  assert.deepEqual([...(await lent.downloadMedia(received.messages[0]))], [7, 8, 9]);

  // media by url: data: goes through; a path or file: would be read from this computer
  const withImage = await lent.sendMessage("447700900002@s.whatsapp.net", {
    image: { url: "data:image/png;base64,AQID" },
  });
  assert.deepEqual([...(await lent.downloadMedia(withImage))], [1, 2, 3]);
  for (const url of ["/etc/passwd", "file:///etc/passwd", "http://192.168.1.1/"])
    await assert.rejects(
      lent.sendMessage("447700900002@s.whatsapp.net", { document: { url } }),
      /must be https: or data:/,
    );

  // the mind unreachable: messages wait, then arrive once over the next connection
  mind.failing = true;
  await lent.simulateIncomingMessage({
    from: "447700900003@s.whatsapp.net",
    text: "while you were away",
  });
  await mind.settled();
  const before = mind.events.length;
  mind.failing = false;
  await provideDummy({ itx: mind.itx }); // what `iterate provide` does on its next connection
  await mind.settled();
  assert.equal(mind.events.length, before + 1);
  assert.equal(
    (mind.events.at(-1)!.payload.data as any).messages[0].message.conversation,
    "while you were away",
  );
});

test("a message WhatsApp delivers again with a different body stays one event, and never holds up the next", async () => {
  const mind = pretendMind();
  const ev = new EventEmitter();
  const lend = lendOver({
    logPath: "/integrations/whatsapp",
    connect: async (onSocket) => onSocket({ ev } as unknown as Parameters<typeof onSocket>[0]),
    downloadMedia: async () => new Uint8Array(),
  });
  await lend({ itx: mind.itx });
  const message = (id: string, text: string) => ({
    key: { remoteJid: "447700900003@s.whatsapp.net", fromMe: false, id },
    message: { conversation: text },
  });
  ev.emit("messages.upsert", { type: "notify", messages: [message("A", "first")] });
  await mind.settled();
  // the same message as an `append`, in one batch with a new one: the platform refuses the batch
  ev.emit("messages.upsert", {
    type: "append",
    messages: [message("A", "first"), message("B", "second")],
  });
  await mind.settled();
  ev.emit("messages.upsert", { type: "notify", messages: [message("C", "third")] });
  await mind.settled();
  const messages = (events: WhatsAppEvent[]) =>
    events
      .map((event) => event.payload.data as any)
      .map((data) => [data.type, data.messages[0].key.id]);
  assert.deepEqual(messages(mind.events), [
    ["notify", "A"],
    ["append", "B"],
    ["notify", "C"],
  ]);
  assert.deepEqual(
    messages(mind.streams.get("/integrations/whatsapp/chats/447700900003@s.whatsapp.net")!),
    [
      ["notify", "A"],
      ["append", "B"],
      ["notify", "C"],
    ],
  );
});

test("after a restart the account's own stream is appended first, and the chats' streams after it, a few at once", async () => {
  const OWN = "/integrations/whatsapp";
  const mind = heldMind();
  const ev = new EventEmitter();
  const lend = lendOver({
    logPath: OWN,
    connect: async (onSocket) => onSocket({ ev } as unknown as Parameters<typeof onSocket>[0]),
    downloadMedia: async () => new Uint8Array(),
  });
  await lend({ itx: mind.itx });
  const from = (chat: number, id: string) => ({
    key: { remoteJid: `4477009000${chat}@s.whatsapp.net`, fromMe: false, id },
    message: { conversation: id },
  });
  // what WhatsApp sends after a restart: messages of twenty chats at once
  const chats = Array.from({ length: 20 }, (_, index) => 10 + index);
  ev.emit("messages.upsert", {
    type: "append",
    messages: chats.map((chat) => from(chat, `old-${chat}`)),
  });
  await mind.asked();
  // the account's stream alone, with all twenty: no chat's stream is asked for before it answers
  assert.deepEqual(mind.open(), [[OWN, 20]]);

  mind.answer();
  await mind.asked();
  // then the chats' streams: eight at once, no more
  assert.deepEqual(
    mind.open(),
    chats.slice(0, 8).map((chat) => [`${OWN}/chats/4477009000${chat}@s.whatsapp.net`, 1]),
  );

  // a new message while those are open: it goes on the account's stream before the next chats
  ev.emit("messages.upsert", { type: "notify", messages: [from(10, "new")] });
  await mind.asked();
  assert.equal(mind.open().length, 8);
  mind.answer();
  await mind.asked();
  assert.deepEqual(mind.open(), [[OWN, 1]]);

  while (mind.open().length > 0) {
    assert.ok(mind.open().length <= 8);
    mind.answer();
    await mind.asked();
  }
  // all of it landed, each stream in the order it came
  const ids = (path: string) =>
    mind.streams.get(path)!.map((event) => (event.payload.data as any).messages[0].key.id);
  assert.deepEqual(ids(OWN), [...chats.map((chat) => `old-${chat}`), "new"]);
  assert.deepEqual(ids(`${OWN}/chats/447700900010@s.whatsapp.net`), ["old-10", "new"]);
  for (const chat of chats.slice(1))
    assert.deepEqual(ids(`${OWN}/chats/4477009000${chat}@s.whatsapp.net`), [`old-${chat}`]);
  // and never two appends open on one stream
  assert.equal(mind.mostOpenOnOneStream, 1);
});

test("what failed over a connection that a newer one replaced meanwhile goes over the newer one, with no new event", async () => {
  const OWN = "/integrations/whatsapp";
  const old = heldMind();
  const newer = heldMind();
  const ev = new EventEmitter();
  const lend = lendOver({
    logPath: OWN,
    connect: async (onSocket) => onSocket({ ev } as unknown as Parameters<typeof onSocket>[0]),
    downloadMedia: async () => new Uint8Array(),
  });
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (line: string) => void errors.push(line);
  try {
    await lend({ itx: old.itx });
    ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "447700900003@s.whatsapp.net", fromMe: false, id: "A" },
          message: { conversation: "a photo" },
        },
      ],
    });
    await old.asked();
    assert.deepEqual(old.open(), [[OWN, 1]]);
    // the next connection comes while the first append is still open, and then that append fails
    await lend({ itx: newer.itx });
    old.answer(new Error("RPC session was shut down by disposing the main stub"));
    await newer.asked();
    assert.deepEqual(newer.open(), [[OWN, 1]]);
    newer.answer();
    await newer.asked();
    newer.answer();
    await newer.asked();
  } finally {
    console.error = consoleError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /2 event\(s\) wait for the mind's next connection/);
  assert.equal(old.streams.size, 0);
  assert.equal(newer.streams.get(OWN)!.length, 1);
  assert.equal(newer.streams.get(`${OWN}/chats/447700900003@s.whatsapp.net`)!.length, 1);
});

test("every other event of the socket lands as whatsapp/<its Baileys name>, and user() and the LID mapping are lent", async () => {
  const mind = pretendMind();
  const ev = new EventEmitter();
  let emitAll: (events: Record<string, unknown>) => void = () => {};
  const socket = {
    ev: Object.assign(ev, { process: (handler: typeof emitAll) => void (emitAll = handler) }),
    user: { id: "447700900001:1@s.whatsapp.net", lid: "111:1@lid", name: "Me" },
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid: string) =>
          lid === "222@lid" ? "447700900002@s.whatsapp.net" : null,
        getLIDForPN: async () => "222@lid",
      },
    },
  };
  const lend = lendOver({
    logPath: "/integrations/whatsapp",
    connect: async (onSocket) => onSocket(socket as unknown as Parameters<typeof onSocket>[0]),
    downloadMedia: async () => new Uint8Array(),
  });
  const lent = (await lend({ itx: mind.itx })) as Lent;
  const key = { remoteJid: "447700900002@s.whatsapp.net", fromMe: true, id: "A" };
  // one batch, as Baileys emits them: a receipt, a group change, the keys, and a message
  emitAll({
    "messages.update": [
      { key, update: { status: 3 } },
      { key: { ...key, remoteJid: "222@lid", id: "B" }, update: { status: 4 } },
    ],
    "group-participants.update": {
      id: "1@g.us",
      author: "447700900002@s.whatsapp.net",
      participants: ["3@lid"],
      action: "add",
    },
    "creds.update": { noiseKey: "secret" },
    "messages.upsert": { type: "notify", messages: [] },
  });
  await mind.settled();
  assert.deepEqual(
    mind.events.map(({ type, payload }) => [type, payload]),
    [
      [
        "whatsapp/messages.update",
        {
          event: "messages.update",
          data: [
            { key, update: { status: 3 } },
            { key: { ...key, remoteJid: "222@lid", id: "B" }, update: { status: 4 } },
          ],
        },
      ],
      [
        "whatsapp/group-participants.update",
        {
          event: "group-participants.update",
          data: {
            id: "1@g.us",
            author: "447700900002@s.whatsapp.net",
            participants: ["3@lid"],
            action: "add",
          },
        },
      ],
    ],
  );
  // each chat's own stream holds its part, in the event's own shape; a chat known by its `@lid`
  // goes by the phone number WhatsApp told this account
  assert.deepEqual(
    [...mind.streams]
      .filter(([path]) => path.includes("/chats/"))
      .map(([path, events]) => [path, events.map((event) => event.payload)]),
    [
      [
        "/integrations/whatsapp/chats/447700900002@s.whatsapp.net",
        [
          { event: "messages.update", data: [{ key, update: { status: 3 } }] },
          {
            event: "messages.update",
            data: [{ key: { ...key, remoteJid: "222@lid", id: "B" }, update: { status: 4 } }],
          },
        ],
      ],
      [
        "/integrations/whatsapp/chats/1@g.us",
        [
          {
            event: "group-participants.update",
            data: {
              id: "1@g.us",
              author: "447700900002@s.whatsapp.net",
              participants: ["3@lid"],
              action: "add",
            },
          },
        ],
      ],
    ],
  );
  assert.deepEqual(await lent.user(), socket.user);
  assert.equal(await lent.getPNForLID("222@lid"), "447700900002@s.whatsapp.net");
  assert.ok((await lent.__describe()).functions.includes("user"));
});

test("with a list, only the functions it names are lent: the other ways to send, and logout, are not there to call", async () => {
  const called: string[] = [];
  const socket = {
    ev: Object.assign(new EventEmitter(), { process: () => {} }),
    user: { id: "447700900001:1@s.whatsapp.net" },
    sendMessage: async () => void called.push("sendMessage"),
    // Baileys' `sendMessage` calls `relayMessage`: a mind that holds one by name must not get the other
    relayMessage: async () => void called.push("relayMessage"),
    sendNode: async () => void called.push("sendNode"),
    groupMetadata: async (jid: string) => ({ id: jid, subject: "The group" }),
    logout: async () => void called.push("logout"),
  };
  const lendWith = async (only?: readonly string[]) =>
    (await lendOver({
      logPath: "/integrations/whatsapp",
      only,
      connect: async (onSocket) => onSocket(socket as unknown as Parameters<typeof onSocket>[0]),
      downloadMedia: async () => new Uint8Array([1]),
    })({ itx: pretendMind().itx })) as Lent;

  const lent = await lendWith(["sendMessage", "groupMetadata", "downloadMedia", "noSuchFunction"]);
  const names = ["__describe", "downloadMedia", "groupMetadata", "sendMessage"];
  assert.deepEqual(Object.keys(lent).sort(), names);
  for (const name of ["relayMessage", "sendNode", "logout", "user", "getPNForLID", "getLIDForPN"])
    assert.equal(lent[name], undefined, `${name} is lent`);
  // what an agent reads names the same functions, and says that the rest is not lent
  const described = lent.__describe!() as unknown as { instructions: string; functions: string[] };
  assert.deepEqual(described.functions, names);
  assert.match(described.instructions, /Only the functions listed under `functions` are lent/);
  // a listed function still reaches the socket
  await lent.sendMessage!("447700900002@s.whatsapp.net", { text: "hi" });
  assert.deepEqual(called, ["sendMessage"]);

  // with no list, the whole socket, as before
  const whole = await lendWith(undefined);
  for (const name of ["sendMessage", "relayMessage", "sendNode", "logout", "user", "downloadMedia"])
    assert.equal(typeof whole[name], "function", `${name} is not lent`);
  assert.doesNotMatch(
    (whole.__describe!() as unknown as { instructions: string }).instructions,
    /Only the functions listed/,
  );
  // a list that names nothing lends nothing but the description
  assert.deepEqual(Object.keys(await lendWith([])), ["__describe"]);
});

test("a lend's description is one line within the mind's limit of 500 characters, whatever the account's text and the list", () => {
  const tenNames = [
    "sendMessage",
    "downloadMedia",
    "groupMetadata",
    "groupFetchAllParticipating",
    "onWhatsApp",
    "profilePictureUrl",
    "fetchStatus",
    "user",
    "getPNForLID",
    "getLIDForPN",
  ];
  const account =
    "Sam's own personal WhatsApp account, +44 7700 900123: writing from it is writing as Sam, so ask Sam first";
  // the case that a mind refused: ten names and an account's text of some hundred characters
  const listed = describeLend(account, tenNames, "/integrations/whatsapp/personal");
  assert.ok(listed.length <= 500, `${listed.length} characters`);
  assert.ok(listed.startsWith(account), "the account's text is whole when there is room");
  assert.match(listed, /it lends 10 named functions of it and no other; call __describe\(\) first/);
  assert.doesNotMatch(listed, /groupFetchAllParticipating/);
  assert.match(listed, /\(\/integrations\/whatsapp\/personal\)\.$/);
  assert.match(describeLend(account, ["sendMessage"], "/x"), /it lends 1 named function of it/);
  // a long list, an account's text of many lines, and no list at all: each is one line in the limit
  const long = `${"A long account text.\n".repeat(60)}`;
  const many = Array.from({ length: 300 }, (_, at) => `aFunctionWithALongName${at}`);
  for (const lend of [many, tenNames, [], undefined]) {
    const said = describeLend(long, lend, "/integrations/whatsapp/personal");
    assert.ok(said.length <= 500, `${said.length} characters`);
    assert.doesNotMatch(said, /\n/);
    // what gives way is the account's text: how to use the lend and where its events land stay
    assert.match(said, /call __describe\(\) first.*\(\/integrations\/whatsapp\/personal\)\.$/);
  }
});

test("WHATSAPP_LEND is names with commas between them; unset is the whole socket, and empty is no function", () => {
  assert.equal(lendOnly(undefined), undefined);
  assert.deepEqual(lendOnly("sendMessage, groupMetadata ,downloadMedia,"), [
    "sendMessage",
    "groupMetadata",
    "downloadMedia",
  ]);
  assert.deepEqual(lendOnly(""), []);
});

test("what must stay on this computer is held back from an event: the QR code, a history sync's rows; a long list is appended in parts", () => {
  assert.deepEqual(
    eventPayloads("connection.update", { qr: "2@secret", connection: "connecting" }),
    [
      {
        event: "connection.update",
        data: { connection: "connecting", qr: "(shown on the computer lending WhatsApp)" },
      },
    ],
  );
  assert.deepEqual(
    eventPayloads("messaging-history.set", {
      chats: [{}, {}],
      contacts: [{}],
      messages: [{}, {}, {}],
      isLatest: true,
    }),
    [
      {
        event: "messaging-history.set",
        data: { isLatest: true, chats: 2, contacts: 1, messages: 3 },
      },
    ],
  );
  const contacts = Array.from({ length: 120 }, (_, index) => ({ id: `${index}@lid` }));
  assert.deepEqual(
    eventPayloads("contacts.upsert", contacts).map(({ part, data }) => [
      part,
      (data as unknown[]).length,
    ]),
    [
      [{ from: 0, of: 120 }, 50],
      [{ from: 50, of: 120 }, 50],
      [{ from: 100, of: 120 }, 20],
    ],
  );
  assert.deepEqual(eventPayloads("creds.update", { noiseKey: "secret" }), []);
});

test("an event's part for each chat keeps the event's own shape, and the account's own events have none", () => {
  const key = (remoteJid: string, id: string) => ({ remoteJid, id, fromMe: false });
  assert.deepEqual(
    [
      ...chatParts("message-receipt.update", [
        { key: key("1@g.us", "A"), receipt: {} },
        { key: key("2@g.us", "B"), receipt: {} },
        { key: key("1@g.us", "C"), receipt: {} },
      ]),
    ],
    [
      [
        "1@g.us",
        [
          { key: key("1@g.us", "A"), receipt: {} },
          { key: key("1@g.us", "C"), receipt: {} },
        ],
      ],
      ["2@g.us", [{ key: key("2@g.us", "B"), receipt: {} }]],
    ],
  );
  assert.deepEqual(
    [...chatParts("presence.update", { id: "1@g.us", presences: {} })],
    [["1@g.us", { id: "1@g.us", presences: {} }]],
  );
  assert.deepEqual(
    [...chatParts("messages.delete", { keys: [key("1@g.us", "A")] })],
    [["1@g.us", { keys: [key("1@g.us", "A")] }]],
  );
  assert.deepEqual(
    [...chatParts("call", [{ chatId: "9@s.whatsapp.net", id: "c", status: "offer" }])],
    [["9@s.whatsapp.net", [{ chatId: "9@s.whatsapp.net", id: "c", status: "offer" }]]],
  );
  for (const [name, data] of [
    ["connection.update", { connection: "open" }],
    ["contacts.update", [{ id: "5@lid", notify: "Sam" }]],
    ["blocklist.set", { blocklist: [] }],
  ] as const)
    assert.deepEqual([...chatParts(name, data)], []);
});

/** A mind whose `cd(path).append` stays open until the test answers it: `open()` is the appends
 *  that wait, in the order they were asked, each as its stream and how many events it carries;
 *  `answer()` lets all of them land (or fail with `error`); `asked()` waits for the lend's next
 *  step. */
function heldMind() {
  const waiting: { path: string; events: WhatsAppEvent[]; settle: (error?: Error) => void }[] = [];
  const mind = {
    streams: new Map<string, WhatsAppEvent[]>(),
    mostOpenOnOneStream: 0,
    open: () => waiting.map(({ path, events }) => [path, events.length]),
    answer: (error?: Error) => {
      for (const call of waiting.splice(0)) call.settle(error);
    },
    asked: async () => {
      for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
    },
    itx: {
      cd: (path: string) => ({
        append: (...events: WhatsAppEvent[]) =>
          new Promise<void>((resolve, reject) => {
            waiting.push({
              path,
              events,
              settle: (error) => {
                if (error) return reject(error);
                mind.streams.set(path, [...(mind.streams.get(path) ?? []), ...events]);
                resolve();
              },
            });
            mind.mostOpenOnOneStream = Math.max(
              mind.mostOpenOnOneStream,
              waiting.filter((call) => call.path === path).length,
            );
          }),
      }),
    } as Itx,
  };
  return mind;
}

/** A mind whose `cd(path).append` keeps the events, or fails while `failing`. As the platform
 *  does, a key it holds dedupes the same body and refuses a different one, the whole call with it,
 *  by message alone (what reaches `iterate provide`). */
function pretendMind() {
  const mind: {
    /** every stream appended to, by its path */
    streams: Map<string, WhatsAppEvent[]>;
    /** the account's stream: the one that is no chat's */
    readonly events: WhatsAppEvent[];
    failing: boolean;
    calls: Promise<unknown>[];
    itx: Itx;
    settled: () => Promise<void>;
  } = {
    streams: new Map<string, WhatsAppEvent[]>(),
    get events() {
      return [...mind.streams].find(([path]) => !path.includes("/chats/"))?.[1] ?? [];
    },
    failing: false,
    calls: [] as Promise<unknown>[],
    itx: {
      cd: (path: string) => ({
        append: (...events: WhatsAppEvent[]) => {
          const stream = mind.streams.get(path) ?? [];
          const held = (event: WhatsAppEvent) =>
            stream.findIndex((kept) => kept.idempotencyKey === event.idempotencyKey);
          const conflict = events.find(
            (event) =>
              held(event) >= 0 && JSON.stringify(stream[held(event)]) !== JSON.stringify(event),
          );
          const call: Promise<unknown> = mind.failing
            ? Promise.reject(new Error("the mind is unreachable"))
            : conflict
              ? Promise.reject(
                  new Error(
                    `idempotency key "${conflict.idempotencyKey}" already names a different event at offset ${held(conflict)}`,
                  ),
                )
              : Promise.resolve(
                  mind.streams.set(path, [...stream, ...events.filter((event) => held(event) < 0)]),
                );
          mind.calls.push(call.catch(() => {}));
          return call;
        },
      }),
    } as Itx,
    /** every append made so far has answered */
    settled: async () => {
      for (let round = 0; round < 5; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.all(mind.calls);
      }
    },
  };
  return mind;
}

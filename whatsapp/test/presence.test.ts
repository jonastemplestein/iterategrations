// presence.test.ts — the personal account never looks online just because this computer holds its
// link, and any other account keeps Baileys' defaults. The real connection code (connectBaileys,
// reconnects included) over a pretend Baileys: its event emitter Baileys' own, its socket doing what
// Baileys 7.0.0-rc14 does with presence, and nothing reaching WhatsApp or an auth folder.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vite-plus/test";
import type { BaileysEventMap, SocketConfig } from "baileys";
import type { Itx } from "../src/whatsapp.ts";

type Node = { tag: string; attrs: Record<string, string> };
type PretendSocket = {
  config: SocketConfig;
  ev: ReturnType<typeof import("baileys").makeEventBuffer>;
  /** every node the socket sent */
  sent: Node[];
  user: unknown;
  sendPresenceUpdate(type: string, toJid?: string): Promise<void>;
};

const baileys = vi.hoisted(() => ({
  sockets: [] as PretendSocket[],
  creds: {} as { me?: { id: string; name?: string } },
}));

vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("baileys")>();
  /** Baileys' makeWASocket, as far as presence goes */
  const makeWASocket = (options: Partial<SocketConfig>): PretendSocket => {
    const config = { ...actual.DEFAULT_CONNECTION_CONFIG, ...options } as SocketConfig;
    const { creds } = config.auth;
    const ev = actual.makeEventBuffer(config.logger);
    const sent: Node[] = [];
    // encode.ts leaves out an attribute that is undefined
    const sendNode = async ({ tag, attrs }: { tag: string; attrs: Record<string, unknown> }) =>
      void sent.push({
        tag,
        attrs: Object.fromEntries(
          Object.entries(attrs).filter(([, value]) => value !== undefined),
        ) as Record<string, string>,
      });
    // chats.ts sendPresenceUpdate
    const sendPresenceUpdate = async (type: string, toJid?: string) => {
      if (type === "available" || type === "unavailable") {
        if (!creds.me?.name) return;
        ev.emit("connection.update", { isOnline: type === "available" });
        await sendNode({ tag: "presence", attrs: { name: creds.me.name, type } });
      } else await sendNode({ tag: "chatstate", attrs: { to: toJid, state: type } });
    };
    // socket.ts: the name, announced on a creds.update that names another
    ev.on("creds.update", (update) => {
      const name = update.me?.name;
      if (creds.me?.name !== name) void sendNode({ tag: "presence", attrs: { name } });
      Object.assign(creds, update);
    });
    // chats.ts: at each connection, "available" unless markOnlineOnConnect is false
    ev.on("connection.update", ({ connection }) => {
      if (connection === "open")
        void sendPresenceUpdate(config.markOnlineOnConnect ? "available" : "unavailable");
    });
    const socket: PretendSocket = {
      config,
      ev,
      sent,
      get user() {
        return creds.me;
      },
      sendPresenceUpdate,
    };
    baileys.sockets.push(socket);
    return socket;
  };
  return {
    ...actual,
    default: makeWASocket,
    useMultiFileAuthState: async () => ({
      state: { creds: baileys.creds, keys: {} },
      saveCreds: async () => {},
    }),
    fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
  };
});

const itx = { cd: () => ({ append: async () => {} }) } as Itx;
type Lent = Record<string, (...args: any[]) => Promise<any>>;

/** The lend as `iterate provide` starts it, with WHATSAPP_LOG_PATH as given. */
async function lend(logPath: string): Promise<Lent> {
  vi.stubEnv("WHATSAPP_LOG_PATH", logPath);
  vi.resetModules();
  const { default: provide } = await import("../src/whatsapp.ts");
  return (await provide({ itx })) as Lent;
}

const emit = <T extends keyof BaileysEventMap>(
  socket: PretendSocket,
  event: T,
  data: BaileysEventMap[T],
) => socket.ev.emit(event, data);

/** What WhatsApp is told of the account's presence: each `<presence>`, by its type ("available"
 *  for none, as WhatsApp reads it). */
const presences = (socket: PretendSocket) =>
  socket.sent
    .filter((node) => node.tag === "presence")
    .map((node) => node.attrs.type ?? "available");

/** The connection drops (WhatsApp's 428) and the lend opens a new one a second later. */
async function reconnect(): Promise<PretendSocket> {
  const before = baileys.sockets.length;
  emit(baileys.sockets.at(-1)!, "connection.update", {
    connection: "close",
    lastDisconnect: {
      error: Object.assign(new Error("closed"), { output: { statusCode: 428 } }),
      date: new Date(),
    },
  });
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(baileys.sockets.length, before + 1);
  return baileys.sockets.at(-1)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  baileys.sockets.length = 0;
  baileys.creds = { me: { id: "447700900001:5@s.whatsapp.net", name: "Jonas" } };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("the personal account says 'unavailable' at every connection, reconnects included, and never 'available'", async () => {
  await lend("/integrations/whatsapp-personal");
  const first = baileys.sockets[0]!;
  assert.equal(first.config.markOnlineOnConnect, false);
  emit(first, "connection.update", { connection: "open" });
  // app-state sync counters: Baileys would announce the name with each, a bare <presence/>
  emit(first, "creds.update", { accountSyncCounter: 1 });
  emit(first, "creds.update", { lastAccountSyncTimestamp: 2 });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(presences(first), ["unavailable"]);

  const second = await reconnect();
  assert.equal(second.config.markOnlineOnConnect, false);
  // the guard is on the new socket too: its sync counters announce nothing
  emit(second, "connection.update", { connection: "open" });
  emit(second, "creds.update", { accountSyncCounter: 3 });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(presences(second), ["unavailable"]);
});

test("the personal account takes a new name without announcing it, and keeps what each update carries", async () => {
  await lend("/integrations/whatsapp-personal");
  const socket = baileys.sockets[0]!;
  emit(socket, "creds.update", { me: { ...baileys.creds.me!, name: "Jonas T" } });
  emit(socket, "creds.update", { accountSyncCounter: 4 });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(presences(socket), []);
  assert.deepEqual(baileys.creds, {
    me: { id: "447700900001:5@s.whatsapp.net", name: "Jonas T" },
    accountSyncCounter: 4,
  });
  // and the next connection's "unavailable" goes under it
  emit(socket, "connection.update", { connection: "open" });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(socket.sent, [
    { tag: "presence", attrs: { name: "Jonas T", type: "unavailable" } },
  ]);
});

test("the agents' own account keeps Baileys' defaults: 'available' at every connection, its name announced, typing lent", async () => {
  const lent = await lend("/integrations/whatsapp");
  const first = baileys.sockets[0]!;
  assert.equal(first.config.markOnlineOnConnect, true); // Baileys' default, untouched
  emit(first, "connection.update", { connection: "open" });
  emit(first, "creds.update", { accountSyncCounter: 1 });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(presences(first), ["available", "available"]);
  await lent.sendPresenceUpdate("composing", "447700900002@s.whatsapp.net");
  assert.deepEqual(first.sent.at(-1), {
    tag: "chatstate",
    attrs: { to: "447700900002@s.whatsapp.net", state: "composing" },
  });

  const second = await reconnect();
  assert.equal(second.config.markOnlineOnConnect, true);
  emit(second, "creds.update", { accountSyncCounter: 2 });
  emit(second, "connection.update", { connection: "open" });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(presences(second), ["available", "available"]);
});

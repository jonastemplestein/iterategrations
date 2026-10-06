// herdr.ts — Herdr (the terminal workspace manager for coding agents) lent to an iterate project from
// the computer it runs on, with `iterate provide`:
//   - CALLS: `itx.jonas.herdr.call(method, params)` is Herdr's whole socket API.
//   - EVENTS: what happens in Herdr lands on a stream of the project as `herdr/<kind>`. News (panes,
//     worktrees, an agent's status) is durable; focus and layout are ephemeral, live subscribers only.
// Herdr's socket takes one JSON line a request and closes after the answer; `events.subscribe` is the
// one connection that stays open. The wire is the contract, so there is no client library.
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** The stream Herdr's events land on. */
const LOG_PATH = process.env.HERDR_LOG_PATH || "/integrations/herdr/primary";

/** Who this Herdr is, in the description a model reads: HERDR_LABEL="Jonas's Herdr on his Mac". */
const LABEL = process.env.HERDR_LABEL || "Herdr";

/** Where Herdr listens, in Herdr's own order: HERDR_SOCKET_PATH, a named session, the default. */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const config = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr");
  return env.HERDR_SESSION
    ? join(config, "sessions", env.HERDR_SESSION, "herdr.sock")
    : join(config, "herdr.sock");
}

export type Itx = { cd(path: string): { append(...events: HerdrEvent[]): Promise<unknown> } };

/** An event as it lands: `herdr/<kind>`, Herdr's data under `data`. Ephemeral ones are never kept. */
export type HerdrEvent = {
  type: `herdr/${string}`;
  payload: { event: string; data: unknown };
  ephemeral?: true;
};

/** News: what exists, and what the agents in it are doing. Every other kind is "right now" state
 *  (focus, layout, titles), which a snapshot rebuilds: ephemeral. */
const DURABLE = new Set([
  "snapshot",
  "workspace_created",
  "workspace_closed",
  "workspace_renamed",
  "worktree_created",
  "worktree_opened",
  "worktree_removed",
  "tab_created",
  "tab_closed",
  "tab_renamed",
  "pane_created",
  "pane_closed",
  "pane_exited",
  "pane_agent_detected",
  "pane_agent_status_changed",
]);

/** What `events.subscribe` takes without a pane. Left out on purpose: `pane.scroll_changed` (four fifths
 *  of Herdr's events, and no news) and `pane.output_matched`; read output with `pane.read`. */
const SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
];

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** Read a socket's newline-delimited lines. */
function lines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) onLine(line);
    }
  });
}

let requests = 0;

/** One request, its own connection: Herdr answers once and closes. A Herdr error rejects with its
 *  code and message. */
export function request(
  path: string,
  method: string,
  params: unknown = {},
  timeoutMs = 30_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new HerdrError("timeout", `${method} did not answer in ${timeoutMs} ms`)),
        ),
      timeoutMs,
    );
    socket.on("error", (error) =>
      finish(() =>
        reject(new HerdrError("unreachable", `Herdr's socket ${path}: ${error.message}`)),
      ),
    );
    socket.on("close", () =>
      finish(() => reject(new HerdrError("closed", `Herdr closed before it answered ${method}`))),
    );
    lines(socket, (line) =>
      finish(() => {
        const reply = JSON.parse(line);
        if (reply.error) reject(new HerdrError(reply.error.code, reply.error.message));
        else resolve(reply.result);
      }),
    );
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id: `r${++requests}`, method, params })}\n`),
    );
  });
}

type Frame = { event: string; data?: Record<string, unknown> };

/** `events.subscribe`: resolves, with a way to close it, once Herdr says `subscription_started`; each
 *  frame goes to `onFrame`; `closed` says why the connection ended. A refused subscription rejects. */
function subscribe(path: string, subscriptions: unknown[], onFrame: (frame: Frame) => void) {
  return new Promise<{ closed: Promise<string>; close(): void }>((resolve, reject) => {
    const socket = createConnection(path);
    let started = false;
    let end: (reason: string) => void = () => {};
    const closed = new Promise<string>((done) => (end = done));
    socket.on("error", (error) => {
      if (!started) reject(new HerdrError("unreachable", error.message));
      end(error.message);
    });
    socket.on("close", () => {
      if (!started)
        reject(new HerdrError("closed", "Herdr closed before it started the subscription"));
      end("closed");
    });
    lines(socket, (line) => {
      const message = JSON.parse(line);
      if (started) return onFrame(message);
      if (message.error) {
        reject(new HerdrError(message.error.code, message.error.message));
        socket.destroy();
      } else {
        started = true;
        resolve({ closed, close: () => socket.destroy() });
      }
    });
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } })}\n`,
      ),
    );
  });
}

/** Herdr names an event `workspace_focused` as it arrives, and `pane.agent_status_changed` when it
 *  answers a subscription of that name: one spelling, Herdr's own `EventKind`, underscores. */
const kindOf = (event: string) => event.replaceAll(".", "_");

/** The lend. `socket` is Herdr's; `retryMs` is the wait before dialing Herdr again, the tests' to shorten. */
export function createBridge(input: { logPath: string; socket: string; retryMs?: number }) {
  let itx: Itx | undefined;
  let watching: Promise<void> | undefined;
  let stopping = false;
  /** Appends go one after another, so events land in the order Herdr said them. */
  let appended: Promise<unknown> = Promise.resolve();
  const log = (line: string) => console.error(`Herdr: ${line}`);

  /** A failed append is lost, and says so: the next `herdr/snapshot` is where to start again. */
  const emit = (kind: string, data: unknown) => {
    const event: HerdrEvent = { type: `herdr/${kind}`, payload: { event: kind, data } };
    if (!DURABLE.has(kind)) event.ephemeral = true;
    appended = appended
      .then(() => itx?.cd(input.logPath).append(event))
      .catch((error: unknown) =>
        log(`${kind} was not appended (${error instanceof Error ? error.message : String(error)})`),
      );
  };

  const snapshot = async () => emit("snapshot", await request(input.socket, "session.snapshot"));

  /** One connection of events. Panes are subscribed to when it opens (`pane.agent_status_changed`
   *  needs a pane), so a pane that appears or goes ends it and the next one starts with the new set.
   *  Subscribed first, then the snapshot: Herdr's own rule, since events cannot be replayed over one. */
  const session = async (): Promise<string> => {
    const { panes } = await request(input.socket, "pane.list");
    const known = new Set<string>(panes.map((pane: { pane_id: string }) => pane.pane_id));
    let again = false;
    let close = () => {};
    const stream = await subscribe(
      input.socket,
      [
        ...SUBSCRIPTIONS.map((type) => ({ type })),
        ...[...known].map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
      ],
      (frame) => {
        const { type: _type, ...data } = frame.data ?? {};
        const kind = kindOf(frame.event);
        emit(kind, data);
        if (["pane_created", "pane_closed", "pane_exited"].includes(kind)) {
          again = true;
          close();
        }
      },
    );
    close = () => stream.close();
    await snapshot();
    // a pane that came between the list and the subscription is one the status streams miss
    const now = await request(input.socket, "pane.list");
    if (now.panes.some((pane: { pane_id: string }) => !known.has(pane.pane_id))) again = true;
    if (again) close();
    const reason = await stream.closed;
    return again ? "again" : reason;
  };

  /** Keep a session going until `stop`: Herdr restarting, a handoff, or a pane coming or going ends one. */
  const watch = async () => {
    while (!stopping) {
      let reason: string;
      try {
        reason = await session();
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (stopping || reason === "again") continue;
      log(`${reason}; dialing again`);
      await new Promise((resolve) => setTimeout(resolve, input.retryMs ?? 2_000));
    }
  };

  // Named `call`, never `invoke`: `invoke(expression)` is the platform's own dispatch method on every
  // handle, and shadows a lent function of that name (the call fails before it reaches this file).
  const lent = {
    /** Herdr's socket API: the method's name (`agent.list`) and its params; answers Herdr's result. */
    call: async (method: string, params: unknown = {}) => {
      if (typeof method !== "string" || !/^[a-z_]+(\.[a-z_]+)*$/.test(method))
        throw new Error(
          `A Herdr method is a name like agent.list or pane.read, not ${JSON.stringify(method)}.`,
        );
      if (method === "events.subscribe")
        throw new Error(
          `events.subscribe streams, which a call cannot carry: read ${input.logPath}.`,
        );
      const waits = (params as { timeout_ms?: unknown } | null)?.timeout_ms;
      return await request(
        input.socket,
        method,
        params ?? {},
        30_000 + (typeof waits === "number" ? waits : 0),
      );
    },
  };

  return {
    /** `iterate provide`'s default export: called on every connection to the project. Events that
     *  came while it was away are lost; a snapshot says where things stand now. */
    provide: async ({ itx: next }: { itx: Itx }) => {
      itx = next;
      if (watching) void snapshot().catch((error) => log(`no snapshot (${error.message})`));
      else watching = watch();
      return lent;
    },
    stop: () => {
      stopping = true;
    },
  };
}

/** One line of at most 500 characters, which is what the platform takes of a lend's description. */
export const description = `${LABEL}. call(method, params) is Herdr's socket API, documented at https://raw.githubusercontent.com/herdrdev/herdr/v0.9.3/docs/next/website/src/content/docs/socket-api.mdx : call("agent.list"), call("agent.prompt", { target, text }), call("pane.read", { pane_id, source: "recent" }), call("session.snapshot"). Events land on ${LOG_PATH} as herdr/<kind>: news is durable, focus and layout are ephemeral (name the type to get one).`;

export default createBridge({ logPath: LOG_PATH, socket: socketPath() }).provide;

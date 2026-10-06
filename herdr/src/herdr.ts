// herdr.ts — Herdr (the terminal workspace manager for coding agents) lent to an iterate project
// from the computer it runs on, with `iterate provide`:
//   - CALLS: one function, `call(method, params)`, is Herdr's whole socket API
//     (https://herdr.dev/docs/socket-api): `itx.jonas.herdr.call("agent.list")`.
//   - EVENTS: what happens in Herdr lands on a stream of the project as `herdr/<kind>`. The
//     structural ones (a pane, a worktree, an agent's status) are durable; the ones about where you
//     look right now (focus, layout) are ephemeral, live subscribers only. Scroll positions and
//     pane output are never subscribed to: they are most of the traffic and none of the news.
// Herdr's socket takes one JSON line a request and closes after the answer; `events.subscribe` is the
// one connection that stays open. Nothing here depends on a Herdr client: the wire is the contract.
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** The stream Herdr's events land on. */
const LOG_PATH = process.env.HERDR_LOG_PATH || "/integrations/herdr/primary";

/** Who this Herdr is, in the description a model reads: HERDR_LABEL="Jonas's Herdr on his Mac". */
const LABEL = process.env.HERDR_LABEL || "Herdr";

/** Event kinds never appended, by their name: HERDR_SKIP_EVENTS=pane_updated,layout_updated. */
const SKIP = new Set(
  (process.env.HERDR_SKIP_EVENTS || "")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean),
);

/** Where Herdr listens: Herdr's own order, HERDR_SOCKET_PATH, then a named session, then the default. */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const config = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr");
  return env.HERDR_SESSION
    ? join(config, "sessions", env.HERDR_SESSION, "herdr.sock")
    : join(config, "herdr.sock");
}

export type Itx = { cd(path: string): { append(...events: HerdrEvent[]): Promise<unknown> } };

/** An event of Herdr as it lands: `herdr/<kind>`, Herdr's own data under `data`. A durable one has an
 *  idempotency key (what waited for the project and is appended again lands once); an ephemeral one
 *  has none, it is never kept. */
export type HerdrEvent = {
  type: `herdr/${string}`;
  payload: { event: string; data: unknown };
  idempotencyKey?: string;
  ephemeral?: true;
};

/** Events that are news: the set of workspaces, tabs and panes, and what the agents in them are
 *  doing. Every other kind is "right now" state, which a snapshot rebuilds: ephemeral. */
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

/** What `events.subscribe` takes without a pane. `pane.agent_status_changed` needs a pane, so each
 *  pane has a connection of its own. `pane.scroll_changed` and `pane.output_matched` are left out. */
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

/** A durable event waits for the project, up to this many; the oldest is dropped past it. */
const PENDING_LIMIT = 1000;

/** The wait before the watch dials Herdr again, by the failures in a row. */
const RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

let requestCount = 0;

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    timer = setTimeout(
      () =>
        finish(() =>
          reject(new HerdrError("timeout", `${method} did not answer in ${timeoutMs} ms`)),
        ),
      timeoutMs,
    );
    socket.on("error", (error) =>
      finish(() =>
        reject(
          new HerdrError("unreachable", `no answer from Herdr's socket ${path}: ${error.message}`),
        ),
      ),
    );
    socket.on("close", () =>
      finish(() => reject(new HerdrError("closed", `Herdr closed before it answered ${method}`))),
    );
    lines(socket, (line) =>
      finish(() => {
        try {
          const reply = JSON.parse(line);
          if (reply.error) reject(new HerdrError(reply.error.code, reply.error.message));
          else resolve(reply.result);
        } catch (error) {
          reject(error);
        }
      }),
    );
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id: `r${++requestCount}`, method, params })}\n`),
    );
  });
}

type Frame = { event: string; data?: Record<string, unknown> };
type Stream = { closed: Promise<string>; close(): void };

/** `events.subscribe`: resolves once Herdr says `subscription_started`, then hands each frame over
 *  until the connection ends; `closed` says why it ended. A refused subscription rejects. */
function subscribe(
  path: string,
  subscriptions: unknown[],
  onFrame: (frame: Frame) => void,
): Promise<Stream> {
  return new Promise((resolve, reject) => {
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
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!started) {
        if (message.error) {
          reject(new HerdrError(message.error.code, message.error.message));
          socket.destroy();
        } else if (message.result?.type === "subscription_started") {
          started = true;
          resolve({ closed, close: () => socket.destroy() });
        }
        return;
      }
      if (typeof message.event === "string") onFrame(message);
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

/** The lend. `socket` is Herdr's; `input.retryMs` is the tests'. */
export function createBridge(input: {
  logPath: string;
  socket: string;
  skip?: ReadonlySet<string>;
  retryMs?: number[];
}) {
  const skip = input.skip ?? new Set<string>();
  const retryMs = input.retryMs ?? RETRY_MS;
  let itx: Itx | undefined;
  let stopping = false;
  let watching: Promise<void> | undefined;
  /** An event's key says which run of this process appended it, and in what order. */
  const run = Date.now().toString(36);
  let count = 0;
  const pending: HerdrEvent[] = [];
  let flushing: Promise<void> | undefined;
  let ephemeralRefused = false;
  const log = (line: string) => console.error(`Herdr: ${line}`);

  /** Append what waits, in order, over the newest connection, one flush at a time; a failure leaves
   *  it waiting for the next connection or the next event. */
  const flush = (): Promise<void> =>
    (flushing ??= (async () => {
      try {
        while (itx && pending.length > 0) {
          const batch = pending.slice(0, 50);
          await itx.cd(input.logPath).append(...batch);
          pending.splice(0, batch.length);
        }
        return true;
      } catch (error) {
        log(
          `${pending.length} event(s) wait for the project (${error instanceof Error ? error.message : String(error)})`,
        );
        return false;
      }
    })().then((appended) => {
      flushing = undefined;
      if (appended && itx && pending.length > 0) void flush(); // arrived as it finished
    }));

  const emit = (kind: string, data: unknown) => {
    if (skip.has(kind)) return;
    const payload = { event: kind, data };
    if (DURABLE.has(kind)) {
      pending.push({
        type: `herdr/${kind}`,
        payload,
        idempotencyKey: `herdr/${kind}:${run}:${++count}`,
      });
      if (pending.length > PENDING_LIMIT) {
        const dropped = pending.splice(0, pending.length - PENDING_LIMIT);
        log(`dropped ${dropped.length} event(s) the project never took`);
      }
      void flush();
    } else if (itx && !ephemeralRefused) {
      // live only: nobody listening (no connection) is the end of it
      itx
        .cd(input.logPath)
        .append({ type: `herdr/${kind}`, payload, ephemeral: true })
        .catch((error: unknown) => {
          // the platform may take no ephemeral from a session: say so once, and stop trying
          ephemeralRefused = true;
          log(
            `ephemeral events are refused, so they are dropped (${error instanceof Error ? error.message : String(error)})`,
          );
        });
    }
  };

  const onFrame = (frame: Frame) => {
    const { type: _type, ...data } = frame.data ?? {};
    emit(kindOf(frame.event), data);
  };

  const paneExists = async (paneId: string) => {
    try {
      const { panes } = await request(input.socket, "pane.list");
      return (panes as { pane_id: string }[]).some((pane) => pane.pane_id === paneId);
    } catch {
      return true; // cannot tell: let the session end and start again
    }
  };

  /** One connection to Herdr: events from now on, then a snapshot (what is true now), and the
   *  agent status of each pane; ends, saying why, when anything it holds drops. */
  const session = async (): Promise<string> => {
    const panes = new Map<string, Stream | null>(); // null: being opened
    let end: (reason: string) => void = () => {};
    const ended = new Promise<string>((done) => (end = done));
    const watchPane = async (paneId: string) => {
      if (panes.has(paneId)) return;
      panes.set(paneId, null);
      try {
        const stream = await subscribe(
          input.socket,
          [{ type: "pane.agent_status_changed", pane_id: paneId }],
          onFrame,
        );
        panes.set(paneId, stream);
        void stream.closed.then(async (reason) => {
          if (panes.get(paneId) !== stream) return; // closed on purpose
          panes.delete(paneId);
          if (await paneExists(paneId)) end(`the status stream of ${paneId} closed (${reason})`);
        });
      } catch (error) {
        panes.delete(paneId);
        if (await paneExists(paneId))
          end(
            `no status stream for ${paneId} (${error instanceof Error ? error.message : String(error)})`,
          );
      }
    };
    const unwatchPane = (paneId: string) => {
      const stream = panes.get(paneId);
      panes.delete(paneId);
      stream?.close();
    };
    const main = await subscribe(
      input.socket,
      SUBSCRIPTIONS.map((type) => ({ type })),
      (frame) => {
        onFrame(frame);
        const kind = kindOf(frame.event);
        const data = frame.data ?? {};
        if (kind === "pane_created") {
          const paneId = (data.pane as { pane_id?: string } | undefined)?.pane_id;
          if (paneId) void watchPane(paneId);
        } else if (kind === "pane_closed" || kind === "pane_exited") {
          if (typeof data.pane_id === "string") unwatchPane(data.pane_id);
        }
      },
    );
    void main.closed.then((reason) => end(`the event stream closed (${reason})`));
    try {
      const snapshot = await request(input.socket, "session.snapshot");
      emit("snapshot", snapshot);
      const { panes: listed } = await request(input.socket, "pane.list");
      for (const pane of listed as { pane_id: string }[]) void watchPane(pane.pane_id);
      return await ended;
    } finally {
      main.close();
      for (const stream of panes.values()) stream?.close();
      panes.clear();
    }
  };

  /** Keep a session going until `stop`. */
  const watch = async () => {
    for (let failures = 0; !stopping;) {
      const started = Date.now();
      let reason: string;
      try {
        reason = await session();
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (stopping) return;
      if (Date.now() - started > 10_000) failures = 0; // it served: a fresh round of attempts
      const wait = retryMs[Math.min(failures++, retryMs.length - 1)]!;
      log(`${reason}; dialing again in ${wait / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
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
    /** `iterate provide`'s default export: called on every connection to the project. */
    provide: async ({ itx: next }: { itx: Itx }) => {
      itx = next;
      watching ??= watch();
      void flush();
      return lent;
    },
    stop: () => {
      stopping = true;
    },
    waiting: () => pending.length,
  };
}

/** One line of at most 500 characters: what the platform takes of a lend's description. */
export const description = `${LABEL}, the workspace manager for coding agents. call(method, params) is Herdr's socket API (https://herdr.dev/docs/socket-api), answering its result: call("agent.list"), ("agent.prompt", { target, text }), ("agent.wait", { target, until: ["idle"], timeout_ms }), ("pane.read", { pane_id, source: "recent" }), ("workspace.list"), ("session.snapshot"); also tab.*, worktree.*, layout.*. Events land on ${LOG_PATH} as herdr/<kind>.`;

export default createBridge({ logPath: LOG_PATH, socket: socketPath(), skip: SKIP }).provide;

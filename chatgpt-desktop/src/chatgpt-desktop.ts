// chatgpt-desktop.ts — the agent of the ChatGPT desktop app (OpenAI's ChatGPT app with Codex), lent to
// an iterate project from the computer it runs on, with `iterate provide`:
//   - CALLS: `itx.jonas.chatgptDesktop.ask(task)` starts a task that works in the app's in-app browser
//     and answers when its turn ends; `start`, `send`, `wait`, `read`, `names`, `archive`; `call(tool,
//     args)` is any of the app's own agent tools.
//   - EVENTS: what the tasks started here (or by the `chatgpt-browser` command line) do lands on a
//     stream of the project as `chatgpt-desktop/<kind>`: each turn's start and end, the agent's
//     messages, its tool calls. Nothing else from the app's sessions is read or sent.
// The app serves its agent tools on a Unix socket in /tmp/codex-browser-use: a 4-byte little-endian
// length, then one JSON-RPC message; `tools/list` and `tools/call`. Every call names a calling thread,
// so the lend keeps one "Agent bridge" task in the app. The wire is the contract: no client library.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** The stream the tasks' events land on. */
const LOG_PATH = process.env.CHATGPT_DESKTOP_LOG_PATH || "/integrations/chatgpt-desktop/primary";

/** Whose app this is, in the description a model reads. */
const LABEL = process.env.CHATGPT_DESKTOP_LABEL || "The ChatGPT desktop app's agent";

const BRIDGE_TITLE = "Agent bridge";
const BRIDGE_PROMPT =
  "This task is the caller identity for outside agents that give website tasks to this app through " +
  "its local tool pipe (iterategrations chatgpt-desktop, and the chatgpt-browser command line). " +
  "There is nothing to do here: reply with the single word ready. Keep this task; do not archive it.";
const BROWSER_MENTION = "[@Browser](plugin://browser@openai-bundled)";
const DONE = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "canceled",
  "errored",
  "error",
]);
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FRAME = 8 * 1024 * 1024;

export type Itx = { cd(path: string): { append(...events: DesktopEvent[]): Promise<unknown> } };

export type DesktopEvent = {
  type: `chatgpt-desktop/${string}`;
  payload: Record<string, unknown>;
  ephemeral?: true;
};

export type Options = {
  socketDir?: string;
  stateDir?: string;
  codexHome?: string;
  logPath?: string;
  /** How often the tasks' rollout files are read for new events. */
  pollMs?: number;
};

type State = {
  socket?: string;
  bridge?: string;
  names?: Record<string, string>;
  threads?: { id: string; at: number }[];
};

export class DesktopError extends Error {}

/** One JSON-RPC request on its own connection: the answer is the frame with our id. */
export function rpc(
  path: string,
  method: string,
  params?: unknown,
  timeoutMs = 30_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = Buffer.alloc(0);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new DesktopError(`${method} did not answer in ${timeoutMs} ms`))),
      timeoutMs,
    );
    socket.on("error", (error) =>
      finish(() => reject(new DesktopError(`${path}: ${error.message}`))),
    );
    socket.on("close", () =>
      finish(() => reject(new DesktopError(`the app closed before ${method}`))),
    );
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        if (message.id === 1) return finish(() => resolve(message));
      }
    });
    socket.on("connect", () => {
      const body = Buffer.from(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
        }),
      );
      if (body.length > MAX_FRAME)
        return finish(() => reject(new DesktopError(`${method} is too large`)));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      socket.write(Buffer.concat([head, body]));
    });
  });
}

export function createLend(options: Options = {}) {
  const socketDir =
    options.socketDir ?? (process.env.CHATGPT_DESKTOP_SOCKET_DIR || "/tmp/codex-browser-use");
  const stateDir =
    options.stateDir ??
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "chatgpt-browser");
  const codexHome = options.codexHome ?? (process.env.CODEX_HOME || join(homedir(), ".codex"));
  const logPath = options.logPath ?? LOG_PATH;
  const statePath = join(stateDir, "state.json");
  const log = (line: string) => console.error(`ChatGPT desktop: ${line}`);

  // ---- state, shared with the chatgpt-browser command line (same file, same lock) ----
  const loadState = (): State => {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return {};
    }
  };
  const saveState = (state: State) => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${statePath}.tmp`, statePath);
  };
  /** A change to the state under a lock both programs honour: a directory that only one can make. */
  const changeState = async <T>(change: (state: State) => T): Promise<T> => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lock = `${statePath}.lockdir`;
    for (let tries = 0; ; tries++) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        // a lock older than 30 s belongs to a program that died holding it
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
        } catch {}
        if (tries > 200) throw new DesktopError("the state file stays locked");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      const state = loadState();
      const result = change(state);
      saveState(state);
      return result;
    } finally {
      rmdirSync(lock);
    }
  };

  // ---- the app's socket and the bridge thread ----
  const isAppSocket = async (path: string) => {
    try {
      const reply = await rpc(path, "tools/list", { threadStartKind: "all" }, 5_000);
      return (reply.result?.tools ?? []).some(
        (tool: { name?: string }) => tool.name === "create_thread",
      );
    } catch {
      return false;
    }
  };
  const appSocket = async (): Promise<string> => {
    const cached = loadState().socket;
    if (cached && existsSync(cached) && (await isAppSocket(cached))) return cached;
    const candidates = existsSync(socketDir)
      ? readdirSync(socketDir)
          .filter((name) => name.endsWith(".sock"))
          .map((name) => join(socketDir, name))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      : [];
    for (const path of candidates) {
      if (await isAppSocket(path)) {
        await changeState((state) => void (state.socket = path));
        return path;
      }
    }
    throw new DesktopError(
      `The ChatGPT desktop app is not running: no app tool socket in ${socketDir}`,
    );
  };

  const rawCall = async (
    path: string,
    caller: string,
    tool: string,
    args: unknown,
    timeoutMs: number,
  ) => {
    const reply = await rpc(
      path,
      "tools/call",
      {
        tool,
        namespace: "codex_app",
        arguments: args ?? {},
        callerSource: "codex",
        callId: `bridge-call-${randomUUID()}`,
        threadId: caller,
        turnId: `bridge-turn-${randomUUID()}`,
      },
      timeoutMs,
    );
    if (reply.error) throw new DesktopError(`${tool}: ${reply.error.message}`);
    const result = reply.result ?? {};
    const text = (result.contentItems ?? [])
      .filter((item: { type: string }) => item.type === "inputText")
      .map((item: { text: string }) => item.text)
      .join("\n");
    if (!result.success) throw new DesktopError(`${tool} failed: ${text.slice(0, 500)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  /** Threads the app knows, newest first; any of them can make the first call, before a bridge exists. */
  const sessionThreadIds = () => {
    const ids: { id: string; at: number }[] = [];
    const root = join(codexHome, "sessions");
    for (const year of existsSync(root) ? readdirSync(root) : [])
      for (const month of readdirSync(join(root, year)))
        for (const day of readdirSync(join(root, year, month)))
          for (const file of readdirSync(join(root, year, month, day)))
            if (file.endsWith(".jsonl"))
              ids.push({
                id: file.slice(-42, -6),
                at: statSync(join(root, year, month, day, file)).mtimeMs,
              });
    return ids
      .sort((a, b) => b.at - a.at)
      .slice(0, 30)
      .map((entry) => entry.id);
  };

  const bridge = async (path: string): Promise<string> => {
    const known = loadState().bridge;
    if (known) return known;
    let caller: string | undefined;
    for (const candidate of sessionThreadIds()) {
      try {
        await rawCall(path, candidate, "list_threads", { limit: 1 }, 30_000);
        caller = candidate;
        break;
      } catch {}
    }
    if (!caller)
      throw new DesktopError(
        "No thread of the app answers as a caller; start any task in the app once",
      );
    const listing = await rawCall(path, caller, "list_threads", { limit: 50 }, 30_000);
    const found = [...(listing.pinnedThreads ?? []), ...(listing.threads ?? [])].find(
      (thread: { title?: string }) => thread.title === BRIDGE_TITLE,
    );
    const id =
      found?.id ??
      (
        await rawCall(
          path,
          caller,
          "create_thread",
          {
            title: BRIDGE_TITLE,
            prompt: BRIDGE_PROMPT,
            target: { type: "projectless", directoryName: "agent-bridge" },
          },
          60_000,
        )
      ).threadId;
    if (!id) throw new DesktopError("Could not make the bridge thread");
    await changeState((state) => void (state.bridge = id));
    return id;
  };

  /** One of the app's tools, from the bridge thread; a vanished bridge is made again, once. */
  const callTool = async (tool: string, args: unknown, timeoutMs = 60_000): Promise<any> => {
    const path = await appSocket();
    try {
      return await rawCall(path, await bridge(path), tool, args, timeoutMs);
    } catch (error) {
      if (!(error instanceof DesktopError) || !error.message.includes("request failed"))
        throw error;
      await changeState((state) => void delete state.bridge);
      return await rawCall(path, await bridge(path), tool, args, timeoutMs);
    }
  };

  // ---- names ----
  const resolve = (ref: string): string => {
    if (typeof ref !== "string")
      throw new DesktopError("A task is a thread id or a name, as a string");
    if (THREAD_ID.test(ref)) return ref;
    const thread = loadState().names?.[ref];
    if (!thread) throw new DesktopError(`No task named ${JSON.stringify(ref)}; names() lists them`);
    return thread;
  };
  const nameOf = (thread: string) =>
    Object.entries(loadState().names ?? {}).find(([, id]) => id === thread)?.[0];

  // ---- waiting for a turn ----
  type Result = {
    thread: string;
    name?: string;
    status: string;
    answer?: string | null;
    turn?: string;
    error?: unknown;
    durationMs?: number;
    hint?: string;
  };
  const snapshot = async (thread: string) =>
    ((await callTool("wait_threads", { targets: [{ threadId: thread }], timeoutMs: 0 })).polls ?? [
      {},
    ])[0] ?? {};

  const wait = async (thread: string, timeoutMs: number, afterTurn?: string): Promise<Result> => {
    const deadline = Date.now() + timeoutMs;
    const name = nameOf(thread);
    let cursor: string | undefined;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { thread, name, status: "running", answer: null };
      const result = await callTool(
        "wait_threads",
        {
          targets: [{ threadId: thread, ...(cursor ? { afterCursor: cursor } : {}) }],
          timeoutMs: Math.max(1_000, Math.min(120_000, remaining)),
        },
        Math.min(remaining, 120_000) + 60_000,
      );
      if (result.errors?.length)
        throw new DesktopError(`wait_threads: ${JSON.stringify(result.errors).slice(0, 500)}`);
      const poll = result.polls?.[0] ?? {};
      cursor = poll.cursor ?? cursor;
      const turn = poll.latestTurn ?? {};
      const reason = result.wake?.reason;
      if (turn.id && turn.id !== afterTurn && DONE.has(turn.status))
        return {
          thread,
          name,
          status: turn.status,
          turn: turn.id,
          answer: poll.latestAssistantMessage?.text ?? null,
          error: turn.error ?? null,
          durationMs: turn.durationMs,
        };
      if (reason && reason !== "turnCompleted" && reason !== "timeout" && !result.timedOut) {
        let flags: string[] = [];
        try {
          flags =
            (await callTool("read_thread", { threadId: thread, turnLimit: 1 })).thread?.status
              ?.activeFlags ?? [];
        } catch {}
        return {
          thread,
          name,
          status: flags.includes("waitingOnApproval") ? "waiting-on-approval" : "needs-attention",
          answer: poll.latestAssistantMessage?.text ?? null,
          hint: "The app shows a prompt for this task, on the computer that lends it.",
        };
      }
    }
  };

  const start = async (
    task: string,
    opts: { name?: string; title?: string; model?: string; thinking?: string } = {},
  ) => {
    if (typeof task !== "string" || !task.trim())
      throw new DesktopError("start(task) needs the task as text");
    if (opts.name !== undefined) {
      if (!NAME.test(opts.name))
        throw new DesktopError("A name is 1-64 characters: a-z, 0-9, '.', '_', '-'");
      if (loadState().names?.[opts.name])
        throw new DesktopError(`The name ${opts.name} is taken; send to it instead`);
    }
    const prompt = task.includes("@Browser") ? task : `${BROWSER_MENTION} ${task}`;
    const args: Record<string, unknown> = { prompt, target: { type: "projectless" } };
    const title = opts.title ?? opts.name;
    if (title) args.title = title;
    if (opts.model) args.model = opts.model;
    if (opts.thinking) args.thinking = opts.thinking;
    const created = await callTool("create_thread", args);
    const thread: string | undefined = created?.threadId;
    if (!thread)
      throw new DesktopError(`The app made no thread: ${JSON.stringify(created).slice(0, 300)}`);
    await changeState((state) => {
      state.threads = [...(state.threads ?? []), { id: thread, at: Date.now() }].slice(-200);
      if (opts.name) {
        state.names ??= {};
        if (state.names[opts.name])
          throw new DesktopError(
            `The name ${opts.name} was taken meanwhile; the task is ${thread}`,
          );
        state.names[opts.name] = thread;
      }
    });
    follow(thread, 0);
    return { thread, name: opts.name };
  };

  // ---- events: the rollout files of the tasks started here ----
  let itx: Itx | undefined;
  let appended: Promise<unknown> = Promise.resolve();
  const emit = (kind: string, payload: Record<string, unknown>, ephemeral = false) => {
    const event: DesktopEvent = { type: `chatgpt-desktop/${kind}`, payload };
    if (ephemeral) event.ephemeral = true;
    appended = appended
      .then(() => itx?.cd(logPath).append(event))
      .catch((error: unknown) =>
        log(`${kind} was not appended (${error instanceof Error ? error.message : String(error)})`),
      );
  };

  /** Where a thread's rollout is: today's or an earlier session folder, or the archive. */
  const rolloutOf = (thread: string): string | undefined => {
    const suffix = `-${thread}.jsonl`;
    const archive = join(codexHome, "archived_sessions");
    const sessions = join(codexHome, "sessions");
    const dirs: string[] = [];
    for (const year of existsSync(sessions) ? readdirSync(sessions).sort().reverse() : [])
      for (const month of readdirSync(join(sessions, year)).sort().reverse())
        for (const day of readdirSync(join(sessions, year, month))
          .sort()
          .reverse())
          dirs.push(join(sessions, year, month, day));
    for (const dir of [...dirs.slice(0, 40), ...(existsSync(archive) ? [archive] : [])]) {
      const file = readdirSync(dir).find((name) => name.endsWith(suffix));
      if (file) return join(dir, file);
    }
    return undefined;
  };

  const followed = new Map<
    string,
    { file?: string; offset: number; rest: string; quietSince: number }
  >();
  /** Follow a thread's rollout from `offset` bytes: 0 for a new task, else from its end as it is now,
   *  so a follow-up sent next is read from its first line. */
  const follow = (thread: string, offset?: number) => {
    if (followed.has(thread)) return;
    const file = rolloutOf(thread);
    const from = offset ?? (file && existsSync(file) ? statSync(file).size : 0);
    followed.set(thread, { file, offset: from, rest: "", quietSince: Date.now() });
  };

  const toEvent = (thread: string, line: any) => {
    const p = line?.payload ?? {};
    const name = nameOf(thread);
    const base = { thread, ...(name ? { name } : {}), at: line?.timestamp };
    if (line?.type === "event_msg" && p.type === "task_started")
      emit("turn_started", { ...base, turn: p.turn_id });
    else if (line?.type === "event_msg" && p.type === "task_complete")
      emit("turn_completed", {
        ...base,
        turn: p.turn_id,
        answer: p.last_agent_message ?? null,
        durationMs: p.duration_ms,
      });
    else if (line?.type === "response_item" && p.type === "message" && p.role === "assistant") {
      const text = (p.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
      emit(
        "message",
        { ...base, phase: p.phase ?? null, text: text.slice(0, 20_000) },
        p.phase !== "final_answer",
      );
    } else if (
      line?.type === "response_item" &&
      (p.type === "function_call" || p.type === "custom_tool_call")
    ) {
      let input: unknown = p.arguments ?? p.input ?? "";
      let title: string | undefined;
      if (typeof input === "string")
        try {
          const parsed = JSON.parse(input);
          title = typeof parsed?.title === "string" ? parsed.title : undefined;
          input = parsed?.code ?? parsed;
        } catch {}
      emit("tool_call", {
        ...base,
        tool: p.namespace ? `${p.namespace}.${p.name}` : p.name,
        ...(title ? { title } : {}),
        input: (typeof input === "string" ? input : JSON.stringify(input)).slice(0, 4_000),
      });
    }
  };

  const readNew = () => {
    for (const [thread, entry] of followed) {
      entry.file ??= rolloutOf(thread);
      if (!entry.file || !existsSync(entry.file)) {
        entry.file = undefined;
        continue;
      }
      const size = statSync(entry.file).size;
      if (size <= entry.offset) {
        if (Date.now() - entry.quietSince > 6 * 3_600_000) followed.delete(thread);
        continue;
      }
      const fd = openSync(entry.file, "r");
      const chunk = Buffer.alloc(Math.min(size - entry.offset, 4 * 1024 * 1024));
      readSync(fd, chunk, 0, chunk.length, entry.offset);
      closeSync(fd);
      entry.offset += chunk.length;
      entry.quietSince = Date.now();
      const lines = (entry.rest + chunk.toString("utf8")).split("\n");
      entry.rest = lines.pop() ?? "";
      for (const text of lines) {
        if (!text.trim()) continue;
        try {
          toEvent(thread, JSON.parse(text));
        } catch (error) {
          log(
            `a line of ${thread} was not read (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const watch = () => {
    // tasks from the last two days that this lend or the command line started, from where they are now
    const since = Date.now() - 48 * 3_600_000;
    for (const entry of loadState().threads ?? []) if (entry.at > since) follow(entry.id);
    timer ??= setInterval(() => {
      for (const entry of loadState().threads ?? [])
        if (entry.at > since && !followed.has(entry.id)) follow(entry.id, 0);
      try {
        readNew();
      } catch (error) {
        log(`reading rollouts failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }, options.pollMs ?? 1_000);
  };

  // Named `call`, never `invoke`: `invoke` is the platform's own dispatch method on every handle.
  const lent = {
    /** Start a website task in the app and wait for the end of its turn (default 4 minutes). */
    ask: async (
      task: string,
      opts: {
        name?: string;
        title?: string;
        timeoutMs?: number;
        model?: string;
        thinking?: string;
      } = {},
    ) => {
      const { thread } = await start(task, opts);
      return await wait(thread, opts.timeoutMs ?? 240_000);
    },
    /** Start a task and answer at once with its thread id (and name); its events tell how it goes. */
    start,
    /** A follow-up in an existing task (thread id or name), then wait for that turn's end. */
    send: async (
      ref: string,
      message: string,
      opts: { wait?: boolean; timeoutMs?: number } = {},
    ) => {
      const thread = resolve(ref);
      if (typeof message !== "string" || !message.trim())
        throw new DesktopError("send(task, message) needs a message");
      const before = (await snapshot(thread)).latestTurn?.id;
      await callTool("send_message_to_thread", { threadId: thread, prompt: message });
      follow(thread);
      if (opts.wait === false) return { thread, name: nameOf(thread), status: "sent" };
      return await wait(thread, opts.timeoutMs ?? 240_000, before);
    },
    /** Wait for the end of a task's current turn. */
    wait: async (ref: string, opts: { timeoutMs?: number } = {}) =>
      await wait(resolve(ref), opts.timeoutMs ?? 240_000),
    /** A task's recent turns, as the app summarizes them. */
    read: async (ref: string, opts: { turns?: number } = {}) =>
      await callTool("read_thread", {
        threadId: resolve(ref),
        turnLimit: Math.max(1, Math.min(10, opts.turns ?? 3)),
        maxOutputCharsPerItem: 4_000,
      }),
    /** Names given with ask/start({ name }), and their thread ids. */
    names: async () => loadState().names ?? {},
    /** Name an existing task. */
    name: async (name: string, thread: string) => {
      if (!NAME.test(name) || !THREAD_ID.test(thread))
        throw new DesktopError("name(name, threadId)");
      await changeState((state) => {
        state.names ??= {};
        if (state.names[name] && state.names[name] !== thread)
          throw new DesktopError(`The name ${name} is taken`);
        state.names[name] = thread;
      });
      return { name, thread };
    },
    archive: async (ref: string) =>
      await callTool("set_thread_archived", { threadId: resolve(ref), archived: true }),
    /** Any of the app's agent tools by name, with its arguments; call("tools") lists them. */
    call: async (tool: string, args: unknown = {}) => {
      if (tool === "tools") {
        const reply = await rpc(await appSocket(), "tools/list", { threadStartKind: "all" });
        return (reply.result?.tools ?? []).map((t: { name: string; description?: string }) => ({
          name: t.name,
          description: (t.description ?? "").slice(0, 200),
        }));
      }
      if (typeof tool !== "string" || !/^[a-z_]+$/.test(tool))
        throw new DesktopError(`Not a tool name: ${JSON.stringify(tool)}`);
      return await callTool(tool, args, 600_000);
    },
    status: async () => {
      const path = await appSocket();
      return {
        socket: path,
        bridge: await bridge(path),
        followed: [...followed.keys()].length,
        logPath,
      };
    },
  };

  return {
    /** `iterate provide`'s default export: called on every connection to the project. */
    provide: async ({ itx: next }: { itx: Itx }) => {
      itx = next;
      watch();
      return lent;
    },
    lent,
    readNew,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** One line of at most 500 characters, which is what the platform takes of a lend's description. */
export const description = `${LABEL}, which does website tasks in the app's in-app browser. ask(task, {name}) starts one and answers {thread, status, answer} when its turn ends (at most 4 min; else wait(task)). send(task, message) follows up or answers its question; task is a thread id or name. Also start, wait, read, names, archive, call(tool, args). Events on ${LOG_PATH}: chatgpt-desktop/turn_started, message, tool_call, turn_completed.`;

export default createLend().provide;

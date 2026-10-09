// chatgpt-desktop.test.ts — the lend over a pretend app (a Unix socket that speaks the app's wire: a
// 4-byte little-endian length, then JSON-RPC; tools/list and tools/call) and a pretend project: ask
// makes a named task with the browser mention and answers its turn; send waits for the new turn, not
// the last one; the tasks' rollout lines land as chatgpt-desktop/<kind>, and the app's own developer
// messages never do; a taken name is refused; with no app, the error says so.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { createLend, description } from "../src/chatgpt-desktop.ts";
import type { DesktopEvent } from "../src/chatgpt-desktop.ts";

const BRIDGE = "01a1aaaa-0000-7000-8000-000000000001";
const OLD = "01a1aaaa-0000-7000-8000-000000000002";
const TASK = "01a1aaaa-0000-7000-8000-000000000003";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** An app with one bridge, one older thread, and the task it makes. */
function pretendApp() {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-desktop-test-"));
  const socketDir = join(root, "sockets");
  const codexHome = join(root, "codex");
  const day = join(codexHome, "sessions", "2026", "10", "09");
  mkdirSync(socketDir);
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-09T10-00-00-${OLD}.jsonl`), "{}\n");
  const calls: { tool: string; args: any; threadId: string }[] = [];
  let turn = 1;
  const reply = (id: number, value: unknown) =>
    frame({
      id,
      jsonrpc: "2.0",
      result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] },
    });
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE(0)) return;
      const { id, method, params } = JSON.parse(
        buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString(),
      );
      if (method === "tools/list")
        return socket.end(
          frame({
            id,
            jsonrpc: "2.0",
            result: { tools: [{ name: "create_thread" }, { name: "wait_threads" }] },
          }),
        );
      const { tool, arguments: args, threadId } = params;
      calls.push({ tool, args, threadId });
      if (tool === "list_threads")
        return socket.end(reply(id, { threads: [{ id: BRIDGE, title: "Agent bridge" }] }));
      if (tool === "create_thread")
        return socket.end(reply(id, { threadId: TASK, hostId: "local" }));
      if (tool === "send_message_to_thread") {
        turn += 1;
        return socket.end(reply(id, { ok: true }));
      }
      if (tool === "wait_threads")
        return socket.end(
          reply(id, {
            timedOut: false,
            wake: { reason: "turnCompleted" },
            polls: [
              {
                cursor: `c${turn}`,
                latestTurn: { id: `turn-${turn}`, status: "completed", durationMs: 10 },
                latestAssistantMessage: { text: `answer ${turn}` },
              },
            ],
          }),
        );
      if (tool === "set_thread_archived")
        return socket.end(reply(id, { threadId: args.threadId, archived: true }));
      socket.end(
        frame({
          id,
          jsonrpc: "2.0",
          error: { code: -32000, message: "Codex app tool request failed" },
        }),
      );
    });
  });
  server.listen(join(socketDir, "app.sock"));
  cleanups.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const lend = createLend({
    socketDir,
    stateDir: join(root, "state"),
    codexHome,
    logPath: "/test/log",
    pollMs: 60_000,
  });
  cleanups.push(lend.stop);
  return { lend, calls, day, root };
}

test("ask makes a named task with the browser mention, from the bridge, and answers its turn", async () => {
  const { lend, calls } = pretendApp();
  const result = await lend.lent.ask("Open example.org and read its link.", { name: "example" });
  assert.equal(result.thread, TASK);
  assert.equal(result.name, "example");
  assert.equal(result.status, "completed");
  assert.equal(result.answer, "answer 1");
  const create = calls.find((call) => call.tool === "create_thread")!;
  assert.match(
    create.args.prompt,
    /^\[@Browser\]\(plugin:\/\/browser@openai-bundled\) Open example\.org/,
  );
  assert.equal(create.args.title, "example");
  assert.equal(create.threadId, BRIDGE);
  assert.deepEqual(await lend.lent.names(), { example: TASK });
});

test("send by name waits for the turn it starts, not the one before", async () => {
  const { lend, calls } = pretendApp();
  await lend.lent.ask("First.", { name: "two-turns" });
  const result = await lend.lent.send("two-turns", "And then?");
  assert.equal(result.answer, "answer 2");
  assert.equal(calls.find((call) => call.tool === "send_message_to_thread")!.args.threadId, TASK);
});

test("a task's rollout lines land as events; the app's developer messages never do", async () => {
  const { lend, day } = pretendApp();
  const events: DesktopEvent[] = [];
  await lend.provide({
    itx: {
      cd: (path) => ({
        append: async (...more) => void (path === "/test/log" && events.push(...more)),
      }),
    },
  });
  const file = join(day, `rollout-2026-10-09T10-01-00-${TASK}.jsonl`);
  writeFileSync(file, "");
  await lend.lent.start("Open example.org.", { name: "events" });
  const lines = [
    { type: "session_meta", payload: { base_instructions: "secret instructions" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer text" }],
      },
    },
    { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Opening it." }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "js",
        arguments: JSON.stringify({
          title: "Open example.org",
          code: "await tab.goto('https://example.org')",
        }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Learn more." }],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "t1",
        last_agent_message: "Learn more.",
        duration_ms: 900,
      },
    },
  ];
  appendFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  lend.readNew();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    events.map((event) => [event.type, event.ephemeral ?? false]),
    [
      ["chatgpt-desktop/turn_started", false],
      ["chatgpt-desktop/message", true],
      ["chatgpt-desktop/tool_call", false],
      ["chatgpt-desktop/message", false],
      ["chatgpt-desktop/turn_completed", false],
    ],
  );
  assert.equal(events[2].payload.title, "Open example.org");
  assert.equal(events[4].payload.answer, "Learn more.");
  assert.equal(events[4].payload.name, "events");
  assert.ok(
    !JSON.stringify(events).includes("developer text") &&
      !JSON.stringify(events).includes("secret instructions"),
  );
});

test("a taken name is refused, and a name must be simple", async () => {
  const { lend } = pretendApp();
  await lend.lent.start("One.", { name: "taken" });
  await assert.rejects(lend.lent.start("Two.", { name: "taken" }), /taken/);
  await assert.rejects(lend.lent.start("Three.", { name: "Has Spaces" }), /a-z/);
});

test("with no app running, the error says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-desktop-none-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const lend = createLend({
    socketDir: join(root, "none"),
    stateDir: join(root, "state"),
    codexHome: root,
  });
  await assert.rejects(lend.lent.ask("Anything."), /not running/);
  assert.ok(description.length <= 500, `description is ${description.length} characters`);
});

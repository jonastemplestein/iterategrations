// herdr.test.ts — the lend over a pretend Herdr (a Unix socket that speaks Herdr's wire: one JSON line
// a request, closed after the answer, `events.subscribe` the one connection that stays open) and a
// pretend project: a call reaches the socket and answers its result; Herdr's events land as herdr/<kind>
// (the news durable, focus ephemeral, scroll never asked for); a pane that appears ends the connection
// and the next one subscribes to it; a dropped connection is dialed again; and a project that comes
// back is given a fresh snapshot, since what happened while it was away is lost.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import provideHerdr, { createBridge, description, socketPath } from "../src/herdr.ts";
import type { HerdrEvent, Itx } from "../src/herdr.ts";

type Subscriber = { socket: Socket; subscriptions: any[] };

/** A Herdr that answers a few methods and streams what the test pushes. */
function pretendHerdr() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
  const path = join(dir, "herdr.sock");
  const subscribers: Subscriber[] = [];
  const requests: { method: string; params: any }[] = [];
  let panes = [{ pane_id: "w1:p1" }];
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const { id, method, params } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      requests.push({ method, params });
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id, result })}\n`);
      if (method === "events.subscribe") {
        subscribers.push({ socket, subscriptions: params.subscriptions });
        socket.write(`${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`);
      } else if (method === "ping") answer({ type: "pong", version: "0.9.3" });
      else if (method === "pane.list") answer({ type: "pane_list", panes });
      else if (method === "session.snapshot")
        answer({ type: "session_snapshot", snapshot: { workspaces: [{ workspace_id: "w1" }] } });
      else if (method === "agent.list") answer({ type: "agent_list", agents: [{ name: "a" }] });
      else
        socket.end(
          `${JSON.stringify({ id, error: { code: "method_not_found", message: `no ${method}` } })}\n`,
        );
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(path, resolve));
  const push = (match: (subs: any[]) => boolean, frame: unknown) => {
    for (const subscriber of subscribers)
      if (!subscriber.socket.destroyed && match(subscriber.subscriptions))
        subscriber.socket.write(`${JSON.stringify(frame)}\n`);
  };
  return {
    path,
    listening,
    requests,
    subscribers,
    setPanes: (next: { pane_id: string }[]) => (panes = next),
    /** a frame to the connection that follows one pane's status, or to the event stream */
    pushStatus: (paneId: string, frame: unknown) =>
      push((subs) => subs.some((sub) => sub.pane_id === paneId), frame),
    pushEvent: (frame: unknown) =>
      push((subs) => subs.some((sub) => sub.type === "pane.created"), frame),
    live: () => subscribers.filter((subscriber) => !subscriber.socket.destroyed),
    drop: () => subscribers.forEach((subscriber) => subscriber.socket.destroy()),
    close: () => {
      subscribers.forEach((subscriber) => subscriber.socket.destroy());
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A project that keeps what is appended to a stream, and fails on request. */
function pretendProject() {
  const events: HerdrEvent[] = [];
  let failures = 0;
  const itx: Itx = {
    cd: () => ({
      append: async (...batch) => {
        if (failures > 0) {
          failures--;
          throw new Error("the project is unreachable");
        }
        events.push(...batch);
        return {};
      },
    }),
  };
  return { itx, events, failNext: (count: number) => (failures = count) };
}

const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`never: ${what}`);
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function started() {
  const herdr = pretendHerdr();
  await herdr.listening;
  const project = pretendProject();
  const bridge = createBridge({
    logPath: "/integrations/herdr/test",
    socket: herdr.path,
    retryMs: 10,
  });
  cleanups.push(() => {
    bridge.stop();
    herdr.close();
  });
  const lent = (await bridge.provide({ itx: project.itx })) as {
    call(method: string, params?: unknown): Promise<any>;
  };
  return { herdr, project, bridge, lent };
}

test("the real lend imports without connecting: a default export and a description", () => {
  assert.equal(typeof provideHerdr, "function");
  assert.match(description, /call\(method, params\)/);
  assert.match(description, /socket-api\.mdx/);
  // the platform refuses a lend whose description is not one line of at most 500 characters; a label
  // (HERDR_LABEL) is up to 40 more
  assert.ok(
    description.length <= 460 && !description.includes("\n"),
    `${description.length} chars`,
  );
});

test("the socket is found in Herdr's own order", () => {
  assert.equal(socketPath({ HERDR_SOCKET_PATH: "/x/s.sock", HERDR_SESSION: "w" }), "/x/s.sock");
  assert.equal(
    socketPath({ HERDR_SESSION: "work", XDG_CONFIG_HOME: "/c" }),
    "/c/herdr/sessions/work/herdr.sock",
  );
  assert.equal(socketPath({ XDG_CONFIG_HOME: "/c" }), "/c/herdr/herdr.sock");
});

test("call answers Herdr's result, and refuses what a call cannot carry", async () => {
  const { lent } = await started();
  assert.deepEqual(await lent.call("agent.list"), { type: "agent_list", agents: [{ name: "a" }] });
  await assert.rejects(lent.call("no.such"), /method_not_found: no no.such/);
  await assert.rejects(lent.call("events.subscribe", { subscriptions: [] }), /streams/);
  await assert.rejects(lent.call("rm -rf"), /not "rm -rf"|not \\?"rm -rf\\?"/);
});

test("events land as herdr/<kind>: news durable, focus ephemeral, scroll never asked for", async () => {
  const { herdr, project } = await started();
  await until(
    () => herdr.live().length === 1 && project.events.length === 1,
    "the connection and the snapshot",
  );

  // one connection: Herdr's 24 kinds and the status of the one pane; no scroll, no output
  const { subscriptions } = herdr.live()[0]!;
  assert.equal(subscriptions.length, 25);
  assert.ok(!subscriptions.some((sub) => /scroll|output/.test(sub.type)));
  assert.deepEqual(subscriptions.at(-1), { type: "pane.agent_status_changed", pane_id: "w1:p1" });

  // the snapshot comes first: what is true now
  assert.equal(project.events[0]!.type, "herdr/snapshot");
  assert.equal(project.events[0]!.ephemeral, undefined);
  assert.deepEqual((project.events[0]!.payload.data as any).snapshot.workspaces, [
    { workspace_id: "w1" },
  ]);

  // a status answers the subscription's dotted name and lands under Herdr's EventKind
  herdr.pushEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done", agent: "claude" },
  });
  await until(() => project.events.length === 2, "the status");
  assert.equal(project.events[1]!.type, "herdr/pane_agent_status_changed");
  assert.equal(project.events[1]!.ephemeral, undefined);
  assert.deepEqual(project.events[1]!.payload, {
    event: "pane_agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done", agent: "claude" },
  });

  // focus arrives with its own `type` in data, which is dropped, and is never kept
  herdr.pushEvent({
    event: "workspace_focused",
    data: { type: "workspace_focused", workspace_id: "w1" },
  });
  await until(() => project.events.length === 3, "the focus");
  assert.equal(project.events[2]!.type, "herdr/workspace_focused");
  assert.equal(project.events[2]!.ephemeral, true);
  assert.deepEqual(project.events[2]!.payload.data, { workspace_id: "w1" });
});

test("a pane that appears ends the connection, and the next one subscribes to it", async () => {
  const { herdr, project } = await started();
  await until(() => herdr.live().length === 1, "the first connection");
  herdr.setPanes([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }]);
  herdr.pushEvent({
    event: "pane_created",
    data: { type: "pane_created", pane: { pane_id: "w1:p2" } },
  });
  await until(
    () => herdr.live().some((s) => s.subscriptions.some((sub) => sub.pane_id === "w1:p2")),
    "a connection that follows the new pane",
  );
  assert.equal(herdr.live().length, 1);
  assert.ok(project.events.some((e) => e.type === "herdr/pane_created"));
  assert.equal(project.events.filter((e) => e.type === "herdr/snapshot").length, 2);
});

test("a dropped connection is dialed again, with a fresh snapshot", async () => {
  const { herdr, project } = await started();
  await until(
    () => project.events.filter((e) => e.type === "herdr/snapshot").length === 1,
    "the first snapshot",
  );
  herdr.drop();
  await until(
    () => project.events.filter((e) => e.type === "herdr/snapshot").length === 2,
    "a second snapshot",
  );
  await until(() => herdr.live().length === 1, "the connection again");
});

test("a project that comes back is given a fresh snapshot, and what it missed is lost", async () => {
  const herdr = pretendHerdr();
  await herdr.listening;
  const project = pretendProject();
  project.failNext(1000); // the project is away
  const bridge = createBridge({
    logPath: "/integrations/herdr/test",
    socket: herdr.path,
    retryMs: 10,
  });
  cleanups.push(() => {
    bridge.stop();
    herdr.close();
  });
  await bridge.provide({ itx: project.itx });
  await until(() => herdr.live().length === 1, "the connection");
  herdr.pushEvent({
    event: "tab_renamed",
    data: { type: "tab_renamed", tab_id: "w1:t1", label: "x" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(project.events.length, 0);
  project.failNext(0);
  await bridge.provide({ itx: project.itx }); // the project's next connection
  await until(() => project.events.length === 1, "the snapshot");
  assert.equal(project.events[0]!.type, "herdr/snapshot");
});

// herdr-kind.test.ts — the `herdr` agent kind (agent-kinds/herdr.ts) over a pretend mind: a
// snapshot of a computer's Herdr makes one agent for each pane that runs a coding agent, with the
// two rows that list it; the same snapshot again adds nothing; a status alone changes the status;
// a pane that closes ends its agent; and a stream that is not a computer's is ignored.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import herdr, { agentPath, CATALOG_ROWS, eventsToRows, personOf } from "../agent-kinds/herdr.ts";

const STREAM = "/integrations/herdr/studio";
const pane = (id: string, more: Record<string, unknown> = {}) => ({
  pane_id: id,
  agent: "claude",
  agent_status: "working",
  cwd: "/home/ada/src/example",
  terminal_title_stripped: "Fix the build",
  agent_session: { value: "session-1" },
  ...more,
});
const snapshot = (offset: number, agents: unknown[]) => ({
  type: "herdr/snapshot",
  path: STREAM,
  offset,
  payload: { event: "snapshot", data: { snapshot: { agents } } },
});

test("a snapshot makes an agent for each agent pane, listed with its computer, title and status", async () => {
  const mind = pretendMind();
  await herdr.processEvent({
    event: snapshot(7, [pane("w1:p1"), pane("w1:p2", { agent: "codex", agent_status: "blocked" })]),
    itx: mind.itx,
  });
  const first = agentPath("studio", "w1:p1");
  assert.equal(first, "/agents/herdr/studio/w1-p1");
  // each context gets its two catalog rows, then what Herdr said
  assert.deepEqual(
    mind.appended
      .filter(({ path }) => path === first)
      .map(({ event }) => event.payload.name || event.type),
    ["herdr-catalog-seen", "herdr-catalog-gone", "herdr/agent-seen"],
  );
  assert.deepEqual(mind.seen(first), {
    computer: "studio",
    pane: "w1:p1",
    status: "working",
    title: "Fix the build",
    activity: "claude in example",
    description:
      "claude in the Herdr pane w1:p1 on studio, in /home/ada/src/example. A person started it by hand; iterate lists it and does not run it. Its session is session-1.",
  });
  // Herdr's `blocked` is the catalog's `waiting`
  assert.equal(mind.seen(agentPath("studio", "w1:p2"))!.status, "waiting");
  assert.equal(mind.seen(agentPath("studio", "w1:p2"))!.activity, "codex in example");
});

test("the same snapshot again adds nothing, and a pane that is gone ends its agent", async () => {
  const mind = pretendMind();
  await herdr.processEvent({ event: snapshot(7, [pane("w1:p1"), pane("w1:p2")]), itx: mind.itx });
  const before = mind.appended.length;
  await herdr.processEvent({ event: snapshot(9, [pane("w1:p1"), pane("w1:p2")]), itx: mind.itx });
  assert.equal(mind.appended.length, before);
  // the second pane closed while the bridge was away
  await herdr.processEvent({ event: snapshot(11, [pane("w1:p1")]), itx: mind.itx });
  assert.deepEqual(
    mind.appended.slice(before).map(({ path, event }) => [path, event.type]),
    [["/agents/herdr/studio/w1-p2", "herdr/agent-gone"]],
  );
  assert.equal(mind.rows.get("/agents/herdr/studio/w1-p2")!.status, "ended");
});

test("a status alone changes the status, and a closed pane ends an agent that is listed", async () => {
  const mind = pretendMind();
  await herdr.processEvent({ event: snapshot(7, [pane("w1:p1")]), itx: mind.itx });
  const path = agentPath("studio", "w1:p1");
  await herdr.processEvent({
    event: {
      type: "herdr/pane_agent_status_changed",
      path: STREAM,
      offset: 8,
      payload: { data: { pane_id: "w1:p1", agent_status: "idle", agent: "claude" } },
    },
    itx: mind.itx,
  });
  assert.deepEqual(mind.seen(path), { computer: "studio", pane: "w1:p1", status: "idle" });
  // an agent that appears in a pane after the snapshot says what it is; its title comes later
  await herdr.processEvent({
    event: {
      type: "herdr/pane_agent_detected",
      path: STREAM,
      offset: 12,
      payload: { data: { pane_id: "w1:p3", agent: "codex", agent_status: "idle" } },
    },
    itx: mind.itx,
  });
  assert.deepEqual(mind.seen(agentPath("studio", "w1:p3")), {
    computer: "studio",
    pane: "w1:p3",
    status: "idle",
    title: "codex in a pane",
    activity: "codex",
    description:
      "codex in the Herdr pane w1:p3 on studio. A person started it by hand; iterate lists it and does not run it.",
  });
  const closed = (id: string, offset: number) => ({
    type: "herdr/pane_closed",
    path: STREAM,
    offset,
    payload: { data: { pane_id: id } },
  });
  // a pane that ran no agent has no context, and gets none
  await herdr.processEvent({ event: closed("w1:p9", 9), itx: mind.itx });
  assert.equal(mind.rows.has(agentPath("studio", "w1:p9")), false);
  await herdr.processEvent({ event: closed("w1:p1", 10), itx: mind.itx });
  assert.equal(mind.appended.at(-1)!.event.type, "herdr/agent-gone");
});

/** As the mind stamps an event that a member's sign-in wrote. */
const by = (email: string) => ({ source: { principal: { actor: "u1", email } } });

test("a bridge on a member's sign-in lists its agents in that member's folder, and an agent listed before the folders ends there and goes on here", async () => {
  const mind = pretendMind();
  // listed before: the bridge's events said no member, so the agent is at the kind's own folder
  await herdr.processEvent({ event: snapshot(7, [pane("w1:p1")]), itx: mind.itx });
  const before = agentPath("studio", "w1:p1");
  assert.equal(mind.rows.get(before)!.status, "working");

  // the same pane, in a snapshot that Ada's sign-in wrote
  await herdr.processEvent({
    event: { ...snapshot(9, [pane("w1:p1")]), ...by("Ada.Lovelace@example.com") },
    itx: mind.itx,
  });
  const mine = agentPath("studio", "w1:p1", "ada-lovelace");
  assert.equal(mine, "/agents/people/ada-lovelace/herdr/studio/w1-p1");
  assert.equal(mind.seen(mine)!.title, "Fix the build");
  // the listing before is ended, and its context stays where it was
  assert.equal(mind.rows.get(before)!.status, "ended");

  // a status and a close find the agent in her folder
  const status = (offset: number, event: string, data: Record<string, unknown>) => ({
    type: `herdr/${event}`,
    path: STREAM,
    offset,
    payload: { event, data },
    ...by("ada.lovelace@example.com"),
  });
  await herdr.processEvent({
    event: status(10, "pane_agent_status_changed", {
      pane_id: "w1:p1",
      agent: "claude",
      agent_status: "idle",
    }),
    itx: mind.itx,
  });
  assert.equal(mind.rows.get(mine)!.status, "idle");
  await herdr.processEvent({
    event: status(11, "pane_closed", { pane_id: "w1:p1" }),
    itx: mind.itx,
  });
  assert.equal(mind.rows.get(mine)!.status, "ended");
});

test("a person's folder is the start of their address; code that wrote for a member counts; nobody is no folder", () => {
  assert.equal(personOf(by("sam@example.com")), "sam");
  assert.equal(personOf(by("Sam.O'Neil+work@example.org")), "sam-o-neil-work");
  assert.equal(
    personOf({ source: { onBehalfOf: { principal: { email: "grace@example.com" } } } }),
    "grace",
  );
  for (const nobody of [{}, { source: {} }, by(""), by("@example.com")])
    assert.equal(personOf(nobody), null);
});

test("events that are not a computer's Herdr stream make nothing", async () => {
  const mind = pretendMind();
  for (const path of ["/integrations/herdr/a/b", "/integrations/herdr/..", "/agents/web/1", "/"])
    await herdr.processEvent({ event: { ...snapshot(1, [pane("w1:p1")]), path }, itx: mind.itx });
  await herdr.processEvent({
    event: { ...snapshot(2, [pane("w1:p1")]), type: "events.iterate.com/agent/message-received" },
    itx: mind.itx,
  });
  assert.deepEqual(mind.appended, []);
});

test("the agent's page says what Herdr said, newest state on the strip", () => {
  const { rows, status } = eventsToRows([
    {
      type: "herdr/agent-seen",
      path: "/agents/herdr/studio/w1-p1",
      offset: 3,
      createdAt: "2026-11-12T04:05:06.000Z",
      payload: { status: "working", title: "Fix the build", activity: "claude in example" },
    },
    { type: "events.iterate.com/itx/woken", path: "/agents/herdr/studio/w1-p1", offset: 4 },
    {
      type: "herdr/agent-gone",
      path: "/agents/herdr/studio/w1-p1",
      offset: 5,
      createdAt: "2026-11-12T04:09:00.000Z",
      payload: { computer: "studio" },
    },
  ]);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["04:05 UTC  working  Fix the build · claude in example", "04:09 UTC  ended"],
  );
  assert.deepEqual(status, { text: "Ended", tone: "muted" });
});

test("the file has no import: a mind's worker and the Agents app's frame load it as it is", () => {
  const source = readFileSync(new URL("../agent-kinds/herdr.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(
    CATALOG_ROWS.every((row) => row.target.path === "/agents"),
    true,
  );
});

/** A mind that keeps what is appended, and folds the two copy rows into catalog rows as the
 *  platform's catalog does for the fields this kind sets. */
function pretendMind() {
  const appended: { path: string; event: any }[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const itx = {
    cd: (path: string) => ({
      append: async (...events: any[]) => {
        for (const event of events) {
          appended.push({ path, event });
          if (event.type === "herdr/agent-seen")
            rows.set(path, { ...rows.get(path), path, ...defined(event.payload) });
          if (event.type === "herdr/agent-gone")
            rows.set(path, { ...rows.get(path), path, status: "ended" });
        }
      },
    }),
    agents: { list: async () => [...rows.values()] },
  };
  /** The payload of the newest `agent-seen` at `path`. */
  const seen = (path: string) =>
    appended.findLast((each) => each.path === path && each.event.type === "herdr/agent-seen")?.event
      .payload;
  return { itx, appended, rows, seen };
}

const defined = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

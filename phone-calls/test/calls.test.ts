// calls.test.ts — the phone lend over a pretend `jeeves-phone serve` (fake-bridge.mjs) and a
// pretend project: a caller the line does not vouch for, and a stranger, are turned away; a known
// caller gets its voice call first and is picked up only then, with that caller's greeting and a
// brief that says the caller is unverified; a note in kv (the phone's, else WhatsApp's) changes
// the greeting; nothing is picked up or placed while a WhatsApp call is in progress; a placed call
// rings once its voice is on the line and reports to the agent that asked; the test caller is
// picked up and marked as a test. A real call needs the line: the README's walkthrough.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

type Appended = { path: string; type: string; payload: Record<string, any> };

const dir = mkdtempSync(join(tmpdir(), "phone-calls-"));
const control = join(dir, "control.jsonl");
const log = join(dir, "log.jsonl");
process.env.PHONE_CALLS_BIN = join(import.meta.dirname, "fake-bridge.mjs");
process.env.FAKE_BRIDGE_CONTROL = control;
process.env.FAKE_BRIDGE_LOG = log;
process.env.PHONE_CALLS_ALLOWED = "447700900001,+44 7700 900002";
process.env.PHONE_CALLS_TEST_FROM = "?phonetest";
process.env.PHONE_CALLS_ANSWER_WITH = JSON.stringify({
  "447700900001": "At your service, sir.",
  "447700900002": "At your service, ma'am.",
  test: "Hello, this is the test line.",
});

const lineSays = (event: Record<string, unknown>) =>
  appendFileSync(control, `${JSON.stringify(event)}\n`);
const bridgeHeard = (): Record<string, any>[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>)
    : [];
async function until<T>(what: string, look: () => T | undefined | false): Promise<T> {
  for (let waited = 0; waited < 5000; waited += 10) {
    const found = look();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A project whose voice app accepts every call a moment after the press, and whose appends, kv
 *  and agent messages are kept; `whatsapp` is what itx.whatsappCalls.status() answers. */
function pretendProject() {
  const listeners = new Map<string, (events: unknown[]) => void>();
  const project = {
    events: [] as Appended[],
    messages: [] as { to: string; text: string }[],
    notes: new Map<string, string>(),
    whatsapp: null as null | { with: string },
    itx: {
      whatsappCalls: { status: async () => project.whatsapp },
      kv: {
        get: async (key: string) => project.notes.get(key) ?? null,
        put: async (key: string, value: string) => void project.notes.set(key, value),
        delete: async (key: string) => void project.notes.delete(key),
      },
      voice: {
        setupVoiceAgent: async ({ streamPath }: { streamPath: string; activation: string }) => {
          setTimeout(
            () =>
              listeners.get(streamPath)?.([
                {
                  type: "events.iterate.com/voice-agent/conversation-accepted",
                  payload: { handshakeTookMs: 1, upgradeTookMs: 1 },
                },
              ]),
            30,
          );
          return { streamPath };
        },
      },
      cd: (path: string) => ({
        append: async (event: { type: string; payload: Record<string, any> }) => {
          project.events.push({ path, type: event.type, payload: event.payload });
          if (event.type === "events.iterate.com/voice-agent/call-ended")
            listeners.get(path)?.([event]);
          return {};
        },
        subscribe: async ({ target }: { target: (events: unknown[]) => void }) => {
          listeners.set(path, target);
          return { [Symbol.dispose]() {} };
        },
      }),
      agents: {
        get: (to: string) => ({
          message: async (text: string) => void project.messages.push({ to, text }),
        }),
      },
    },
  };
  return project;
}

test("phone calls in and out, with an unverified caller ID and one call at a time across lends", async () => {
  const project = pretendProject();
  const { default: provide } = await import("../calls.ts");
  const lent = await provide({ itx: project.itx as never });
  const recorded = (type: string) =>
    project.events.filter((event) => event.type === `phone-calls/${type}`);
  const spoken = () =>
    project.events
      .filter((event) => event.type === "events.iterate.com/agent/web-message-sent")
      .map((event) => [event.path.split("/").slice(0, 4).join("/"), event.payload.message]);
  const briefOf = (client: string) =>
    project.events.findLast(
      (event) =>
        event.type === "events.iterate.com/agent/context-added" &&
        event.path.startsWith(`/agents/voice/${client}/`),
    )!.payload.content as string;

  // a caller the line does not vouch for, claiming a known number: turned away
  lineSays({
    event: "incoming",
    callId: "in-0",
    number: "",
    from: "?+447700900001",
    untrusted: true,
  });
  await until("the untrusted caller turned away", () =>
    bridgeHeard().find((l) => l.reject === "in-0"),
  );
  // a stranger: turned away
  lineSays({ event: "incoming", callId: "in-1", number: "447700900009", from: "07700900009" });
  await until("the stranger turned away", () => bridgeHeard().find((l) => l.reject === "in-1"));
  await until("both recorded", () => recorded("call-received").length === 2);
  assert.deepEqual(
    recorded("call-received").map((event) => event.payload),
    [
      {
        callId: "in-0",
        from: "?+447700900001",
        untrusted: true,
        answering: false,
        reason: "the line does not vouch for the caller's number",
      },
      {
        callId: "in-1",
        from: "+447700900009",
        answering: false,
        reason: "not a number this lend answers",
      },
    ],
  );

  // a known caller: the voice call first, then the pick-up, then the greeting
  lineSays({ event: "incoming", callId: "in-2", number: "447700900001", from: "07700900001" });
  await until("the pick-up", () => bridgeHeard().find((line) => line.answer === "in-2"));
  await until("the greeting", () => spoken().length === 1);
  assert.deepEqual(spoken(), [["/agents/voice/phone-447700900001", "At your service, sir."]]);
  assert.match(
    briefOf("phone-447700900001"),
    /rang your phone number \(a real telephone line, not WhatsApp\)/,
  );
  assert.match(briefOf("phone-447700900001"), /a caller's number can be faked/);
  assert.equal(JSON.parse(project.notes.get("calls/busy")!).lend, "phoneCalls");
  assert.equal(lent.status()?.with, "+447700900001");
  lineSays({ event: "ended", callId: "in-2", reason: "the person hung up", answered: true });
  const ended = await until("the call's end", () => recorded("call-ended")[0]);
  assert.equal(ended.payload.from, "+447700900001");
  assert.equal(ended.payload.direction, "in");
  assert.equal(ended.payload.answered, true);
  assert.match(ended.payload.streamPath, /^\/agents\/voice\/phone-447700900001\//);
  assert.equal(lent.status(), null);
  await until("the busy flag cleared", () => !project.notes.has("calls/busy"));

  // notes: WhatsApp's is read when the phone has none; the phone's own wins
  project.notes.set(
    "whatsapp-calls/answer/447700900002",
    JSON.stringify({
      opening: "The WhatsApp note.",
      brief: "Brief from WhatsApp.",
      until: "2999-01-01T00:00:00Z",
    }),
  );
  lineSays({ event: "incoming", callId: "in-3", number: "447700900002", from: "+447700900002" });
  await until("the WhatsApp note's greeting", () => spoken().length === 2);
  assert.equal(spoken()[1]![1], "The WhatsApp note.");
  assert.match(briefOf("phone-447700900002"), /Brief from WhatsApp\./);
  lineSays({ event: "ended", callId: "in-3", reason: "the person hung up", answered: true });
  await until("its end", () => recorded("call-ended").length === 2);
  project.notes.set(
    "phone-calls/answer/447700900002",
    JSON.stringify({ opening: "The phone note." }),
  );
  lineSays({ event: "incoming", callId: "in-4", number: "447700900002", from: "+447700900002" });
  await until("the phone note's greeting", () => spoken().length === 3);
  assert.equal(spoken()[2]![1], "The phone note.");
  lineSays({ event: "ended", callId: "in-4", reason: "the person hung up", answered: true });
  await until("its end", () => recorded("call-ended").length === 3);

  // a WhatsApp call in progress: nothing picked up, nothing placed
  project.whatsapp = { with: "+447700900002" };
  lineSays({ event: "incoming", callId: "in-5", number: "447700900001", from: "07700900001" });
  await until("turned away while busy", () => bridgeHeard().find((l) => l.reject === "in-5"));
  await assert.rejects(lent.call({ to: "+44 7700 900001" }), /a WhatsApp call is in progress/);
  project.whatsapp = null;

  // a placed call: rung once its voice is on the line, reported to who asked
  await assert.rejects(lent.call({ to: "+44 7700 900009" }), /not a number this lend may ring/);
  const placed = await lent.call({
    to: "+44 7700 900002",
    opening: "Good evening, ma'am.",
    reportTo: "/agents/family-chief-of-staff",
  });
  assert.equal(placed.callId, "out-1");
  assert.match(placed.streamPath, /^\/agents\/voice\/phone-447700900002\//);
  assert.match(
    briefOf("phone-447700900002"),
    /You are on a phone call .* to \+447700900002, which you placed yourself/,
  );
  await until("the opening", () => spoken().length === 4);
  assert.deepEqual(spoken()[3], ["/agents/voice/phone-447700900002", "Good evening, ma'am."]);
  assert.deepEqual(lent.hangup(), { hungUp: true, callId: "out-1" });
  await until("the report", () => project.messages[0]);
  assert.equal(project.messages[0]!.to, "/agents/family-chief-of-staff");
  assert.match(
    project.messages[0]!.text,
    /^\[phone call to \+447700900002 ended after \d+ s: hung up\]/,
  );

  // the test caller: picked up, as a test, by a voice client of its own
  lineSays({ event: "incoming", callId: "in-6", number: "", from: "?phonetest", untrusted: true });
  await until("the test call's greeting", () => spoken().length === 5);
  assert.deepEqual(spoken()[4], ["/agents/voice/phone-test", "Hello, this is the test line."]);
  assert.match(briefOf("phone-test"), /This is a TEST call/);
  lineSays({ event: "ended", callId: "in-6", reason: "the person hung up", answered: true });
  const testEnd = await until("the test call's end", () => recorded("call-ended")[4]);
  assert.equal(testEnd.payload.test, true);
  assert.equal(testEnd.payload.from, "?phonetest");
  assert.equal(project.messages.length, 1, "a test call reports to nobody");
});

// lines.test.ts — one lend with several numbers (PHONE_SIP_NUMBERS), a pretend `jeeves-phone serve`
// for each: each bridge gets its own number, password file and SIP port; a line with no password
// file is not started; a call placed `from` the second number goes through the second bridge, and
// `from` a number that is not the lend's is refused; a call that rings the second line is picked
// up there, its facts carry that line, and a call on another line meanwhile is turned away; a
// line's bridge that dies leaves a call on another line as it was, and is started again.
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { pretendMind, until } from "./pretend-mind.ts";

const dir = mkdtempSync(join(tmpdir(), "phone-lines-"));
const passwords = join(dir, "passwords");
mkdirSync(passwords);
writeFileSync(join(passwords, "447700900010"), "first\n");
writeFileSync(join(passwords, "447700900011"), "second\n");
process.env.PHONE_CALLS_BIN = join(import.meta.dirname, "fake-bridge.mjs");
process.env.FAKE_BRIDGE_CONTROL = join(dir, "control-{line}.jsonl");
process.env.FAKE_BRIDGE_LOG = join(dir, "log-{line}.jsonl");
process.env.PHONE_SIP_NUMBERS = "+447700900010,+44 7700 900011,447700900012";
process.env.PHONE_SIP_PASSWORD_DIR = passwords;
process.env.PHONE_SIP_PORT = "5070";
process.env.PHONE_CALLS_ALLOWED = "447700900001";

const FIRST = "447700900010";
const SECOND = "447700900011";
const lineSays = (digits: string, event: Record<string, unknown>) =>
  appendFileSync(join(dir, `control-${digits}.jsonl`), `${JSON.stringify(event)}\n`);
const bridgeHeard = (digits: string): Record<string, any>[] =>
  existsSync(join(dir, `log-${digits}.jsonl`))
    ? readFileSync(join(dir, `log-${digits}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>)
    : [];

test("one lend, several numbers: each line its own bridge, one call at a time across them", async () => {
  const mind = pretendMind();
  const { default: provide } = await import("../calls.ts");
  const lent = await provide({ itx: mind.itx as never });
  const recorded = (type: string) =>
    mind.events.filter((event) => event.type === `phone-calls/${type}`);

  // each started line's bridge has its own number, password file and port; the third has no file
  await until(
    "both lines registered",
    () => lent.lines().filter((line) => line.ready).length === 2,
  );
  assert.deepEqual(lent.lines(), [
    { number: "+447700900010", ready: true },
    { number: "+447700900011", ready: true },
    { number: "+447700900012", ready: false },
  ]);
  const started = (digits: string) =>
    JSON.parse(readFileSync(join(dir, `log-${digits}.jsonl.env.json`), "utf8"));
  assert.deepEqual(started(FIRST), {
    number: "+447700900010",
    passwordFile: join(passwords, FIRST),
    port: "5070",
  });
  assert.deepEqual(started(SECOND), {
    number: "+447700900011",
    passwordFile: join(passwords, SECOND),
    port: "5071",
  });
  assert.equal(existsSync(join(dir, "log-447700900012.jsonl.env.json")), false);
  const { instructions, functions } = lent.__describe();
  assert.match(
    instructions,
    /^Phone calls on the agents' own numbers \(\+447700900010, the default; \+447700900011; \+447700900012\)/,
  );
  assert.match(instructions, /call\(\{ to, from, opening, brief, reportTo \}\)/);
  assert.ok(functions.includes("lines"));

  // `from` a number that is not the lend's, or a line that is not registered: refused
  await assert.rejects(
    lent.call({ to: "+44 7700 900001", from: "+44 7700 900099" }),
    /one of this lend's numbers \(\+447700900010, \+447700900011, \+447700900012\)/,
  );
  await assert.rejects(
    lent.call({ to: "+44 7700 900001", from: "07700 900012" }),
    /The phone line \+447700900012 is not registered: it has no password file/,
  );
  assert.equal(lent.status(), null);

  // `from` the second number: placed, and hung up, through the second line's bridge only
  const placed = await lent.call({ to: "+44 7700 900001", from: "07700 900011" });
  assert.equal(lent.status()?.line, "+447700900011");
  assert.ok(bridgeHeard(SECOND).some((line) => line.call === "+447700900001"));
  assert.ok(!bridgeHeard(FIRST).some((line) => line.call));
  const brief = mind.events.findLast(
    (event) =>
      event.type === "events.iterate.com/agent/context-added" && event.path === placed.streamPath,
  )!.payload.content as string;
  assert.match(brief, /The call is on your number \+447700900011\./);
  lent.hangup();
  await until("its end", () => recorded("call-ended")[0]);
  assert.ok(bridgeHeard(SECOND).some((line) => line.hangup));
  assert.ok(!bridgeHeard(FIRST).some((line) => line.hangup));
  assert.equal(recorded("call-placed")[0]!.payload.line, "+447700900011");
  assert.equal(recorded("call-answered")[0]!.payload.line, "+447700900011");
  assert.equal(recorded("call-ended")[0]!.payload.line, "+447700900011");

  // no `from`: the default line
  await lent.call({ to: "+44 7700 900001" });
  assert.equal(lent.status()?.line, "+447700900010");
  assert.ok(bridgeHeard(FIRST).some((line) => line.call === "+447700900001"));
  lent.hangup();
  await until("its end", () => recorded("call-ended")[1]);

  // a call rings the second line: picked up there; one on the first meanwhile is turned away
  lineSays(SECOND, {
    event: "incoming",
    callId: "in-1",
    number: "447700900001",
    from: "07700900001",
  });
  await until("the pick-up", () => bridgeHeard(SECOND).find((line) => line.answer === "in-1"));
  await until("the call answered", () => recorded("call-answered")[2]);
  assert.equal(lent.status()?.line, "+447700900011");
  lineSays(FIRST, {
    event: "incoming",
    callId: "in-2",
    number: "447700900001",
    from: "07700900001",
  });
  await until("the second call turned away", () =>
    bridgeHeard(FIRST).find((line) => line.reject === "in-2"),
  );
  assert.equal(lent.status()?.callId, "in-1");
  lineSays(SECOND, {
    event: "ended",
    callId: "in-1",
    reason: "the person hung up",
    answered: true,
  });
  await until("its end", () => recorded("call-ended")[2]);
  assert.deepEqual(
    recorded("call-received").map((event) => [event.payload.callId, event.payload.line]),
    [
      ["in-1", "+447700900011"],
      ["in-2", "+447700900010"],
    ],
  );
  assert.match(recorded("call-received")[1]!.payload.reason, /another call is in progress/);
  assert.equal(recorded("call-answered")[2]!.payload.line, "+447700900011");
  assert.equal(recorded("call-ended")[2]!.payload.line, "+447700900011");
  assert.equal(recorded("call-ended")[2]!.payload.from, "+447700900001");

  // a call on the first line; the second line's bridge dies: the call goes on, the line comes back
  const { callId } = await lent.call({ to: "+44 7700 900001" });
  lineSays(SECOND, { exit: 1 });
  await until("the second line down", () => !lent.lines()[1]!.ready);
  const micFrames = () =>
    mind.events.filter((event) => event.type === "events.iterate.com/voice-agent/mic-frame").length;
  lineSays(FIRST, { event: "mic", pcm: Buffer.alloc(32).toString("base64") });
  await until("a microphone frame from the first line", () => micFrames() === 1);
  assert.equal(lent.status()?.callId, callId);
  assert.equal(recorded("call-ended").length, 3, "the call on the first line did not end");
  await until("the second line started again", () => lent.lines()[1]!.ready, 8_000);
  assert.equal(lent.status()?.callId, callId);
  assert.deepEqual(lent.hangup(), { hungUp: true, callId });
  const ended = await until("its end", () => recorded("call-ended")[3]);
  assert.equal(ended.payload.reason, "hung up");
  assert.equal(ended.payload.line, "+447700900010");
}, 20_000);

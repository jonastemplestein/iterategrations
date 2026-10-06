#!/usr/bin/env node
// A pretend `jeeves-phone serve` for calls.test.ts: it speaks serve.go's lines with no phone line
// behind it. What calls.ts writes to it is logged to $FAKE_BRIDGE_LOG (one JSON line each), and
// each line the test appends to $FAKE_BRIDGE_CONTROL is said as an event of the line's side (an
// incoming call, the other person hanging up). A placed call rings and is answered at once; a
// picked-up call is up at once; a turned-away call ends; a hang-up ends the call.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const say = (event) => console.log(JSON.stringify(event));
let said = 0;
let placed = 0;
let callId = "";
say({ event: "ready", self: "+447441138737" });

setInterval(() => {
  if (!existsSync(process.env.FAKE_BRIDGE_CONTROL)) return;
  const lines = readFileSync(process.env.FAKE_BRIDGE_CONTROL, "utf8").split("\n").filter(Boolean);
  for (const line of lines.slice(said)) say(JSON.parse(line));
  said = lines.length;
}, 10);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const input = JSON.parse(line);
  appendFileSync(process.env.FAKE_BRIDGE_LOG, `${line}\n`);
  if (input.call) {
    callId = `out-${String(++placed)}`;
    say({ event: "ringing", callId });
    say({ event: "answered", callId });
  }
  if (input.answer) {
    callId = input.answer;
    say({ event: "answered", callId });
  }
  if (input.reject)
    say({ event: "ended", callId: input.reject, reason: "turned away", answered: false });
  if (input.hangup)
    say({
      event: "ended",
      callId,
      reason: "hung up",
      answered: true,
      stats: { frameMs: 20, framesPlayed: 0 },
    });
});
lines.on("close", () => process.exit(0));

#!/usr/bin/env node
// A pretend `jeeves-phone serve` for calls.test.ts: it speaks serve.go's lines with no phone line
// behind it. What calls.ts writes to it is logged to $FAKE_BRIDGE_LOG (one JSON line each), and
// each line the test appends to $FAKE_BRIDGE_CONTROL is said as an event of the line's side (an
// incoming call, the other person hanging up). A placed call rings and is answered at once; a
// picked-up call is up at once; a turned-away call ends; a hang-up ends the call. With several
// lines, `{line}` in either path is the line's digits (its PHONE_SIP_NUMBER), and a control line
// `{"exit":<code>}` ends the process, as a line that fails does.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const self = process.env.PHONE_SIP_NUMBER || "+447700900000";
const forLine = (path) => path.replaceAll("{line}", self.replace(/\D/g, ""));
const control = forLine(process.env.FAKE_BRIDGE_CONTROL);
const log = forLine(process.env.FAKE_BRIDGE_LOG);
const say = (event) => console.log(JSON.stringify(event));
// a bridge started again goes on after the control lines its last one said
let said = existsSync(`${control}.said`) ? Number(readFileSync(`${control}.said`, "utf8")) : 0;
let placed = 0;
let callId = "";
// the settings this line's bridge was started with, for the test to check
writeFileSync(
  `${log}.env.json`,
  JSON.stringify({
    number: process.env.PHONE_SIP_NUMBER,
    passwordFile: process.env.PHONE_SIP_PASSWORD_FILE,
    port: process.env.PHONE_SIP_PORT,
  }),
);
say({ event: "ready", self });

setInterval(() => {
  if (!existsSync(control)) return;
  const lines = readFileSync(control, "utf8").split("\n").filter(Boolean);
  for (const line of lines.slice(said)) {
    said += 1;
    const event = JSON.parse(line);
    if (event.exit !== undefined) {
      writeFileSync(`${control}.said`, String(said));
      process.exit(event.exit);
    }
    say(event);
  }
}, 10);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const input = JSON.parse(line);
  appendFileSync(log, `${line}\n`);
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

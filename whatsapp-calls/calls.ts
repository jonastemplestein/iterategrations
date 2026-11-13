// calls.ts — WhatsApp VOICE CALLS for an iterate mind, from its own WhatsApp account, both ways:
//
//   iterate provide whatsapp-calls/calls.ts --name whatsappCalls --mind <address>
//
// OUT: the mind calls `itx.whatsappCalls.call({ to, opening, brief, reportTo })` and the
// person's phone rings on WhatsApp. IN: a person this lend answers (WHATSAPP_CALLS_ALLOWED) rings
// the account and the call is picked up. Either way the call is a voice call like any other the
// mind has: this file is its client (@iterate-com/voice's call client, the voice app's own). Each
// person is a voice device of the mind's, `whatsapp-<the other person's digits>`, provisioned
// once (for a person it answers, when the lend starts) and kept: its relay at `/voice/whatsapp-<digits>` and its agent at
// `/agents/voice/whatsapp-<digits>`, which keeps every call with that person (the number in the
// path: a mind can tell whose phone a call's agent is on). A call is one press on the device; the
// person's words go up as microphone frames and the voice's answer comes back as speaker frames. The
// voice is on the line BEFORE the phone rings or the call is picked up, so the person is spoken to
// at once.
//
// The WhatsApp side is `jeeves-call serve` (serve.go: meowcaller, WhatsApp's call stack, on a
// linked device of its own beside the Baileys one), one process kept running with the calls'
// audio on its stdin and stdout: 16 kHz mono PCM16 both ways, the voice processor's own format.
//
// The mind can leave a note for a caller's next call in its kv, at
// `whatsapp-calls/answer/<the caller's digits>`: JSON `{ opening?, brief?, until? }`, what the voice
// says when it picks up, what the call's agent is told, and the time after which the note is stale.
//
// `jeeves-call serve` is started afresh after every call: a call is carried by a device that has
// carried none before. A call that was accepted and carries no audio is ended by it within a few
// seconds, and the person is rung again, once, by a fresh one.
//
// Each call's facts land on /integrations/whatsapp-calls: `whatsapp-calls/call-placed` or
// `call-received`, `call-answered` (with the caller's agent path) and `call-ended` (with what was
// said).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connectVoiceDevice, type VoiceCall, type VoiceDevice } from "@iterate-com/voice/call";

export const description =
  "WhatsApp voice calls both ways on the agents' own number, lent from a computer. call({ to, opening, brief, reportTo }) rings the person on WhatsApp and connects them to a voice agent that says `opening` and knows `brief`; a call from a known number to the agents' number is answered the same way; hangup(), status(). Call __describe() first.";

const LOG_PATH = "/integrations/whatsapp-calls";
const BRIDGE = process.env.JEEVES_CALL_BIN || join(import.meta.dirname, "jeeves-call");
/** How long the phone rings before the call is given up. */
const RING_SECONDS = 45;
/** The numbers a call may be placed to, and whose calls are answered (digits with country code,
 *  comma-separated): a call rings a real phone and an answered one reaches the mind's agent, so
 *  the lend only talks to the people it was started for. */
const ALLOWED = new Set(
  (process.env.WHATSAPP_CALLS_ALLOWED || "")
    .split(",")
    .map((number) => number.replace(/\D/g, ""))
    .filter(Boolean),
);
/** What the voice says when it picks up, by the caller's digits (JSON, with `default` for anyone
 *  else): `{"447700900001":"At your service, sir.","default":"Hello."}`. */
const ANSWER_WITH: Record<string, string> = (() => {
  try {
    const parsed: unknown = JSON.parse(process.env.WHATSAPP_CALLS_ANSWER_WITH || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    console.error("whatsapp-calls: WHATSAPP_CALLS_ANSWER_WITH is not JSON; answering with Hello");
    return {};
  }
})();

/** The mind, as `iterate provide` hands it over: the parts this file uses. */
type Mind = Parameters<typeof connectVoiceDevice>[0] & {
  agents: { get(path: string): { message(text: string): Promise<unknown> } };
  kv: { get(key: string): Promise<string | null> };
};

type CallInput = {
  /** The person's number, with country code: "+44 7700 900123". */
  to: string;
  /** The first thing the voice says when they answer. */
  opening?: string;
  /** What the call is for and what the voice agent should know: it cannot see your conversation. */
  brief?: string;
  /** An agent's path: it is messaged what was said once the call ends. */
  reportTo?: string;
};

/** What one call measured, recorded with its end: where a call that sounded wrong went wrong. */
type CallMetrics = {
  /** From the press to the live model being on the line, each time the voice was connected. */
  voiceReadyMs: number[];
  /** Out: from the first ring to the answer. In: from the caller's ring to this side's pick-up. */
  ringMs: number | null;
  /** Microphone frames (60 ms each) handed to the voice call, and the ones a slow link dropped or failed. */
  micFramesSent: number;
  micFramesDropped: number;
  micFramesFailed: number;
  /** The voice's audio: chunks received, and their length. */
  speakerChunks: number;
  speakerMs: number;
  /** Why each voice connection of the call ended (more than one: the voice was reconnected). */
  voiceEnds: string[];
  /** The bridge's own count: frames played and heard, gaps in an answer, the deepest queue. */
  bridge: Record<string, number> | null;
};

/** A context of the mind's, as much of it as a voice device uses. */
type VoiceContext = ReturnType<Parameters<typeof connectVoiceDevice>[0]["cd"]>;

/** `streamPath`: the caller's agent, `/agents/voice/whatsapp-<digits>`, which keeps the call. */
type Placed = { callId: string; ringing: true; streamPath: string };

type ActiveCall = {
  /** "out": the mind rang the person. "in": the person rang the account. */
  direction: "out" | "in";
  callId: string;
  /** The other person's number, digits with country code. */
  number: string;
  startedAt: number;
  ringingAt: number | null;
  answeredAt: number | null;
  opening: string | undefined;
  brief: string | undefined;
  reportTo: string | undefined;
  /** The caller's agent, which keeps this call and every one before it; null until the voice is
   *  connected. */
  agentPath: string | null;
  /** Every voice call the WhatsApp call was carried by, by activation: one, unless the voice was
   *  reconnected. */
  activations: string[];
  voice: VoiceCall | null;
  said: string[];
  metrics: CallMetrics;
  /** The WhatsApp call is over: a voice call that ends now is not reconnected. */
  over: boolean;
  /** Out only: settled when the phone rings, or when it cannot. */
  placed: PromiseWithResolvers<Placed> | null;
  /** In only: the mind's note for this caller is being read; the brief waits for it. */
  noted: Promise<void> | null;
  /** The call was accepted and carried no audio, and the person was rung again. */
  redialled: boolean;
};

/** A line of `jeeves-call serve`'s stdout (serve.go). */
type BridgeEvent = {
  event?: string;
  callId?: string;
  pcm?: string;
  reason?: string;
  answered?: boolean;
  stats?: Record<string, number>;
  number?: string;
  from?: string;
  video?: boolean;
  group?: boolean;
};

let itx: Mind | undefined;
let active: ActiveCall | null = null;

/** Each caller's voice device, provisioned once (`itx.voice.ensureVoiceDevice`) and kept: a press
 *  on it is one append. A refused provisioning is asked again on the next call, or on the next
 *  reconnection for a person this lend answers. */
const devices = new Map<string, Promise<VoiceDevice<VoiceContext>>>();
function deviceFor(mind: Mind, number: string): Promise<VoiceDevice<VoiceContext>> {
  const client = `whatsapp-${number}`;
  let device = devices.get(client);
  if (!device) {
    const connected = connectVoiceDevice(mind, { client });
    device = connected;
    devices.set(client, connected);
    connected.catch(() => {
      if (devices.get(client) === connected) devices.delete(client);
    });
  }
  return device;
}
/** serve.go's reason for ending an accepted call that carried no audio. */
const NO_AUDIO = "answered, but no audio flowed";
/** How long a call waits for the device to be connected before it is given up. */
const BRIDGE_READY_TIMEOUT_MS = 20_000;
/** After a call's end, how long the device is left to send its hang-up before it is replaced
 *  (WHATSAPP_CALLS_SETTLE_MS: a test has no hang-up to wait for). */
const BRIDGE_SETTLE_MS = Number(process.env.WHATSAPP_CALLS_SETTLE_MS ?? 2_000);

let bridge: ChildProcessWithoutNullStreams | null = null;
/** `jeeves-call serve` is kept running from the first connection on. */
let bridgeStarted = false;
/** The linked device is connected: calls can be placed. */
let bridgeReady = false;
/** Whoever waits for the device to be connected. */
let bridgeWaiters: (() => void)[] = [];
/** The device is being replaced on purpose: its exit is not a call's end. */
let replacing = false;

/** The voice ended the call itself (its agent hung up, or nobody spoke for a minute): the WhatsApp
 *  call ends too. Any other end is the voice's connection failing, and the call gets a new one. */
const VOICE_ENDED_ON_PURPOSE = /the Agent hung up|no input|idle|whatsapp/i;
const MAX_VOICE_RECONNECTS = 2;
/** How long the live model may take to come on the line before the call is given up. */
const VOICE_READY_TIMEOUT_MS = 12_000;
/** How long a picked-up call may take to carry audio before it is given up. */
const PICK_UP_TIMEOUT_MS = 20_000;

const record = (type: string, payload: Record<string, unknown>) =>
  itx
    ?.cd(LOG_PATH)
    .append({ type: `whatsapp-calls/${type}`, payload })
    .catch((error: unknown) =>
      console.error(`whatsapp-calls: could not record ${type}: ${String(error)}`),
    );

const tell = (line: Record<string, unknown>) => {
  if (bridge?.stdin.writable) bridge.stdin.write(`${JSON.stringify(line)}\n`);
};

/** Settles once the device is connected; refuses when it has not connected in time. */
function bridgeConnected(): Promise<void> {
  if (bridgeReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const connected = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      bridgeWaiters = bridgeWaiters.filter((waiter) => waiter !== connected);
      reject(new Error("The WhatsApp call device did not connect in time: try again."));
    }, BRIDGE_READY_TIMEOUT_MS);
    bridgeWaiters.push(connected);
  });
}

/** A fresh device in place of the one that just carried a call: no call is offered to the old
 *  one from now, and it leaves once its hang-up has had time to go out (its exit starts the new). */
function replaceBridge(): void {
  const old = bridge;
  if (!old) return;
  bridgeReady = false;
  setTimeout(() => {
    if (bridge !== old) return;
    replacing = true;
    old.stdin.end(); // serve.go leaves when its stdin closes
  }, BRIDGE_SETTLE_MS);
}

const newCall = (direction: "out" | "in", number: string): ActiveCall => ({
  direction,
  callId: "",
  number,
  startedAt: Date.now(),
  ringingAt: null,
  answeredAt: null,
  opening: undefined,
  brief: undefined,
  reportTo: undefined,
  agentPath: null,
  activations: [],
  voice: null,
  said: [],
  metrics: {
    voiceReadyMs: [],
    ringMs: null,
    micFramesSent: 0,
    micFramesDropped: 0,
    micFramesFailed: 0,
    speakerChunks: 0,
    speakerMs: 0,
    voiceEnds: [],
    bridge: null,
  },
  over: false,
  placed: null,
  noted: null,
  redialled: false,
});

/** The mind's note for this caller's next call (kv `whatsapp-calls/answer/<digits>`), onto the
 *  call: its opening in place of the usual greeting, its brief for the call's agent. A note past
 *  its `until`, or one that cannot be read, changes nothing. */
async function takeNote(mind: Mind, current: ActiveCall): Promise<void> {
  try {
    const stored = await mind.kv.get(`whatsapp-calls/answer/${current.number}`);
    if (!stored) return;
    const note = JSON.parse(stored) as { opening?: unknown; brief?: unknown; until?: unknown };
    if (typeof note.until === "string" && Date.parse(note.until) < Date.now()) return;
    if (typeof note.opening === "string" && note.opening.trim()) current.opening = note.opening;
    if (typeof note.brief === "string" && note.brief.trim()) current.brief = note.brief;
  } catch (error) {
    console.error(`whatsapp-calls: the note for +${current.number} was not read: ${String(error)}`);
  }
}

const addStats = (current: ActiveCall, ended: VoiceCall) => {
  current.metrics.micFramesSent += ended.stats.micFramesSent;
  current.metrics.micFramesDropped += ended.stats.micFramesDropped;
  current.metrics.micFramesFailed += ended.stats.micFramesFailed;
  current.metrics.speakerChunks += ended.stats.spkChunksReceived;
  current.metrics.speakerMs += Math.round(ended.stats.spkMsReceived);
};

/** A voice call of the mind's for this WhatsApp call, answered once the live model is on the
 *  line. `resumed`: the one before it failed mid-call, and this one is told what was said. */
async function connectVoice(mind: Mind, current: ActiveCall, resumed: boolean): Promise<void> {
  const pressedAt = Date.now();
  const device = await deviceFor(mind, current.number);
  current.agentPath = device.agentPath;
  await current.noted;
  // the brief goes before the press: the agent reads it before the call's first hand-over. Over
  // the newest link: the device may have waited for a move to it
  await (itx ?? mind).cd(device.agentPath).append({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "user",
      actor: { type: "user" },
      content: briefFor(current, resumed),
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  });
  const accepted = Promise.withResolvers<void>();
  let mine: VoiceCall | null = null;
  mine = device.call({
    onSpeakerFrame: (frame) => {
      if (current.voice !== mine) return;
      // nobody is listening until the call is answered: what the voice says before is dropped
      if (current.answeredAt === null) return;
      // the person spoke over the voice: what was queued for them is dropped
      if (frame.clearSpeakerBufferBeforeFrame) tell({ clear: true });
      if (frame.pcm) tell({ pcm: frame.pcm, ...(frame.lastFrameOfAnswer && { last: true }) });
      else if (frame.lastFrameOfAnswer) tell({ last: true });
    },
    onFact: (fact) => {
      if (fact.type === "events.iterate.com/voice-agent/conversation-accepted") accepted.resolve();
      if (fact.type === "events.iterate.com/voice-agent/provider-error-reported")
        console.error(
          `whatsapp-calls: the live model reported: ${fact.payload.message.slice(0, 300)}`,
        );
      if (fact.type === "events.iterate.com/voice-agent/utterance-transcribed")
        current.said.push(`Person: ${fact.payload.text}`);
      if (fact.type === "events.iterate.com/voice-agent/answer-transcribed")
        current.said.push(`Voice: ${fact.payload.text}`);
      if (
        fact.type !== "events.iterate.com/voice-agent/call-ended" ||
        current.voice !== mine ||
        current.over
      )
        return;
      // this voice call is over, and not because the WhatsApp call ended
      const reason = fact.payload.reason;
      current.metrics.voiceEnds.push(reason);
      addStats(current, mine!);
      current.voice = null;
      const reconnects = current.activations.length - 1;
      if (
        VOICE_ENDED_ON_PURPOSE.test(reason) ||
        current.answeredAt === null ||
        reconnects >= MAX_VOICE_RECONNECTS
      ) {
        tell({ hangup: true });
        return;
      }
      // the voice's connection failed while the person is on the line: a new one, told what was said
      console.error(`whatsapp-calls: the voice ended (${reason}); reconnecting it`);
      connectVoice(mind, current, true).catch((error: unknown) => {
        console.error(`whatsapp-calls: the voice could not be reconnected: ${String(error)}`);
        tell({ hangup: true });
      });
    },
  });
  current.activations.push(mine.activation);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    accepted.promise.then(() => true),
    // a refused press is a voice that cannot come on the line
    mine.pressed.then(() => new Promise<never>(() => undefined)),
    new Promise<boolean>(
      (resolve) => (timer = setTimeout(() => resolve(false), VOICE_READY_TIMEOUT_MS)),
    ),
  ]);
  clearTimeout(timer);
  if (!ready || current.over) {
    await mine
      .hangUp(
        ready
          ? "whatsapp: the call ended before the voice was on the line"
          : "whatsapp: the live model did not come on the line",
      )
      .catch(() => undefined);
    throw new Error(
      ready
        ? "The call ended before the voice was on the line."
        : `The voice did not come on the line within ${String(VOICE_READY_TIMEOUT_MS / 1000)} s.`,
    );
  }
  current.metrics.voiceReadyMs.push(Date.now() - pressedAt);
  current.voice = mine;
  // the call is up: a failed apology is logged, not a reason to hang up
  if (resumed)
    void mine
      .speak("I do apologise, the line dropped for a moment. Where were we?")
      .catch((error: unknown) =>
        console.error(`whatsapp-calls: the apology was not said: ${String(error)}`),
      );
}

/** What the caller's agent is told before a call's press. Its history holds the earlier calls
 *  with the same person, so the brief says it is for the call that starts now. */
function briefFor(current: ActiveCall, resumed: boolean): string {
  return [
    current.direction === "out"
      ? `[call brief, for the call that starts now] You are on a WhatsApp voice call to +${current.number}, which you placed yourself${current.reportTo ? ` from your conversation at ${current.reportTo}` : ""}: to the person you are the same assistant they know, not someone calling on its behalf.`
      : `[call brief, for the call that starts now] +${current.number} rang you on WhatsApp and you picked up: to the person you are the same assistant they know. You do not know yet why they are calling.`,
    current.brief ?? "",
    resumed
      ? `The voice connection failed during this call and you are its replacement: the person is still on the line. What was said so far:\n${current.said.join("\n") || "(nothing yet)"}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The WhatsApp call is over: its voice call ends, its end is recorded, and whoever asked for the
 *  report is told. Once per call. */
async function finished(current: ActiveCall, reason: string, answered: boolean): Promise<void> {
  if (current.over) return;
  current.over = true;
  if (active === current) active = null;
  current.placed?.reject(new Error(`The call could not be placed (${reason}).`));
  const seconds = current.answeredAt ? Math.round((Date.now() - current.answeredAt) / 1000) : 0;
  if (current.voice) {
    const last = current.voice;
    current.voice = null;
    await last.hangUp(`whatsapp: the call ended (${reason})`).catch(() => undefined);
    addStats(current, last);
  }
  const transcript = current.said.join("\n");
  const number = `+${current.number}`;
  await record("call-ended", {
    callId: current.callId,
    direction: current.direction,
    ...(current.direction === "out" ? { to: number } : { from: number }),
    answered,
    reason,
    seconds,
    streamPath: current.agentPath,
    activations: current.activations,
    reportTo: current.reportTo ?? null,
    ...(current.redialled && { redialled: true }),
    transcript,
    metrics: current.metrics,
  });
  if (current.reportTo && itx)
    await itx.agents
      .get(current.reportTo)
      .message(
        answered
          ? `[whatsapp call to ${number} ended after ${String(seconds)} s: ${reason}] What was said:\n${transcript || "(nothing was transcribed)"}\n(the caller's agent, with everything it did: ${current.agentPath ?? "none"})`
          : `[whatsapp call to ${number} was not answered: ${reason}]`,
      )
      .catch((error: unknown) =>
        console.error(
          `whatsapp-calls: could not report to ${String(current.reportTo)}: ${String(error)}`,
        ),
      );
}

/** Ring `input.to`. The voice is connected FIRST (a press on the person's voice device, the live
 *  model on the line), and only then does the phone ring: the person who answers is
 *  spoken to at once. Answers once the phone is ringing; everything after (the answer, the end)
 *  is recorded on LOG_PATH and, with `reportTo`, told to that agent at the end. */
async function call(input: CallInput): Promise<Placed> {
  const mind = itx;
  if (!mind) throw new Error("WhatsApp calls are not connected to the mind yet.");
  const digits = String(input?.to ?? "").replace(/\D/g, "");
  if (digits.length < 8)
    throw new Error(
      `call({ to }) needs a phone number with its country code, got ${JSON.stringify(input?.to)}`,
    );
  if (!ALLOWED.has(digits))
    throw new Error(
      `+${digits} is not a number this lend may ring (it rings ${
        [...ALLOWED].map((n) => `+${n}`).join(", ") || "nobody"
      }).`,
    );
  if (active)
    throw new Error(`A call is already in progress (with +${active.number}): one call at a time.`);

  const current = newCall("out", digits);
  current.opening = input.opening;
  current.brief = input.brief;
  current.reportTo = input.reportTo;
  active = current;
  // 1. the voice, before anyone is rung
  try {
    await connectVoice(mind, current, false);
  } catch (error) {
    await finished(
      current,
      `the voice could not be connected: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
    throw error;
  }
  // 2. the phone
  try {
    await bridgeConnected();
  } catch (error) {
    await finished(current, "the call device is not connected", false);
    throw error;
  }
  current.placed = Promise.withResolvers<Placed>();
  tell({ call: `+${digits}`, ring: RING_SECONDS });
  return await current.placed.promise;
}

/** The call was accepted and carried no audio: the person is listening to silence. They are rung
 *  again, once, by a fresh device; the voice stays on the line and has said nothing yet. A call
 *  they placed becomes a call back. */
async function redial(current: ActiveCall): Promise<void> {
  current.redialled = true;
  console.error(`whatsapp-calls: the call with +${current.number} carried no audio; ringing again`);
  void record("call-retried", {
    callId: current.callId,
    direction: current.direction,
    ...(current.direction === "out"
      ? { to: `+${current.number}` }
      : { from: `+${current.number}` }),
    reason: NO_AUDIO,
  });
  if (current.direction === "in") {
    current.direction = "out";
    current.opening = `I do apologise, the line failed just now. ${current.opening ?? ""}`.trim();
    const agentPath = current.agentPath;
    if (agentPath && itx)
      void itx
        .cd(agentPath)
        .append({
          type: "events.iterate.com/agent/context-added",
          payload: {
            role: "user",
            actor: { type: "user" },
            content:
              "[call brief] The line carried no sound when you picked up, so you hung up and rang them straight back: this is that call.",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
        })
        .catch(() => undefined);
  }
  current.callId = "";
  current.ringingAt = null;
  current.answeredAt = null;
  replaceBridge();
  try {
    await bridgeConnected();
  } catch {
    await finished(current, `${NO_AUDIO}, and the call device did not come back`, false);
    return;
  }
  if (current.over) return;
  tell({ call: `+${current.number}`, ring: RING_SECONDS });
}

/** Someone is ringing the account. A call from a number this lend answers gets a voice call of
 *  the mind's first, and is picked up once the live model is on the line; any other call is
 *  left ringing on the account's other devices. */
async function incoming(event: BridgeEvent): Promise<void> {
  const mind = itx;
  const callId = event.callId ?? "";
  const digits = event.number ?? "";
  const from = digits ? `+${digits}` : (event.from ?? "unknown");
  const leave = (reason: string) =>
    record("call-received", { callId, from, answering: false, reason });
  if (!mind) return;
  if (event.group || event.video) return void leave("a group or video call");
  if (!ALLOWED.has(digits)) return void leave("not a number this lend answers");
  if (active) return void leave(`another call is in progress (with +${active.number})`);

  const current = newCall("in", digits);
  current.callId = callId;
  current.ringingAt = Date.now();
  current.opening = ANSWER_WITH[digits] ?? ANSWER_WITH.default ?? "Hello.";
  current.noted = takeNote(mind, current);
  active = current;
  void record("call-received", { callId, from, answering: true });
  try {
    await connectVoice(mind, current, false);
  } catch (error) {
    await finished(
      current,
      `the voice could not be connected: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
    return;
  }
  tell({ answer: callId });
  setTimeout(() => {
    if (current.over || current.answeredAt !== null) return;
    tell({ hangup: true });
    void finished(current, "picked up, but the call never carried audio", false);
  }, PICK_UP_TIMEOUT_MS);
}

function onBridgeEvent(event: BridgeEvent): void {
  const current = active;
  if (event.event === "mic") {
    if (event.pcm) current?.voice?.sendMicFrame(event.pcm);
    return;
  }
  if (event.event === "ready") {
    bridgeReady = true;
    console.error("whatsapp-calls: the call device is connected");
    for (const connected of bridgeWaiters.splice(0)) connected();
    return;
  }
  if (event.event === "incoming") {
    void incoming(event);
    return;
  }
  if (!current) return;
  if (event.event === "ringing") {
    current.callId = event.callId ?? "";
    current.ringingAt = Date.now();
    const streamPath = current.agentPath!;
    void record("call-placed", {
      callId: current.callId,
      to: `+${current.number}`,
      reportTo: current.reportTo ?? null,
      streamPath,
    });
    current.placed?.resolve({ callId: current.callId, ringing: true, streamPath });
    current.placed = null;
    return;
  }
  if (event.event === "failed") {
    if (current.direction === "out" && current.ringingAt === null)
      void finished(current, event.reason ?? "the call could not be placed", false);
    return;
  }
  // an announced call this lend left alone ends too: only the call being carried is acted on
  if (event.callId !== current.callId) return;
  if (event.event === "answered") {
    current.answeredAt = Date.now();
    current.metrics.ringMs = current.ringingAt ? current.answeredAt - current.ringingAt : null;
    void record("call-answered", {
      callId: current.callId,
      direction: current.direction,
      ...(current.direction === "out"
        ? { to: `+${current.number}` }
        : { from: `+${current.number}` }),
      streamPath: current.agentPath,
    });
    // the voice is already on the line: it speaks first
    if (current.opening && current.voice)
      void current.voice
        .speak(current.opening)
        .catch((error: unknown) =>
          console.error(`whatsapp-calls: the opening was not said: ${String(error)}`),
        );
    return;
  }
  if (event.event === "ended") {
    current.metrics.bridge = event.stats ?? null;
    if (event.reason === NO_AUDIO && !current.redialled) {
      void redial(current);
      return;
    }
    // the next call is carried by a device that has carried none
    replaceBridge();
    void finished(current, event.reason ?? "ended", Boolean(event.answered));
  }
}

/** `jeeves-call serve`, kept running: started again at once when it was replaced on purpose, and
 *  a few seconds after it exits by itself. */
function startBridge(): void {
  const child = spawn(BRIDGE, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
  bridge = child;
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: BridgeEvent;
    try {
      event = JSON.parse(line) as BridgeEvent;
    } catch {
      return;
    }
    onBridgeEvent(event);
  });
  child.on("exit", (code) => {
    if (bridge === child) bridge = null;
    bridgeReady = false;
    if (replacing) {
      replacing = false;
      startBridge();
      return;
    }
    console.error(`whatsapp-calls: jeeves-call exited (${String(code)}); starting it again in 5 s`);
    if (active)
      void finished(active, `the call process ended (${String(code)})`, active.answeredAt !== null);
    setTimeout(startBridge, 5000);
  });
}

export default async function provide(connection: { itx: Mind }) {
  const reconnected = itx !== undefined;
  itx = connection.itx;
  // each caller's device moves to the new link, a call in progress with it; a call placed
  // meanwhile waits for the move
  if (reconnected)
    for (const [client, device] of devices) {
      const moved = device.then(async (ready) => {
        await ready.moveTo(connection.itx);
        return ready;
      });
      devices.set(client, moved);
      moved.catch((error: unknown) => {
        console.error(`whatsapp-calls: ${client} could not move to the new link: ${String(error)}`);
        if (devices.get(client) === moved) devices.delete(client);
        if (active?.voice && `whatsapp-${active.number}` === client) tell({ hangup: true });
      });
    }
  // the device of each person this lend answers is provisioned now, not on that person's first
  // call: provisioning took about 4 s, which the person heard as ringing
  for (const number of ALLOWED)
    if (!devices.has(`whatsapp-${number}`))
      deviceFor(connection.itx, number).catch((error: unknown) =>
        console.error(
          `whatsapp-calls: whatsapp-${number} could not be provisioned: ${String(error)}`,
        ),
      );
  // `iterate provide` calls this again on each reconnection: the device stays as it is
  if (!bridgeStarted) startBridge();
  bridgeStarted = true;
  const numbers = [...ALLOWED].map((n) => `+${n}`).join(", ") || "nobody";
  return {
    call,
    /** End the call in progress, if any. */
    hangup() {
      if (!active) return { hungUp: false };
      tell({ hangup: true });
      return { hungUp: true, callId: active.callId };
    },
    /** The call in progress, or null. */
    status() {
      return active
        ? {
            callId: active.callId,
            direction: active.direction,
            with: `+${active.number}`,
            answered: active.answeredAt !== null,
            streamPath: active.agentPath,
          }
        : null;
    },
    __describe: () => ({
      instructions: `WhatsApp voice calls from the agents' own number. call({ to, opening, brief, reportTo }) rings a person on WhatsApp: the voice is connected first, then the phone rings (it answers { callId, ringing, streamPath } once it does; the ring gives up after ${String(RING_SECONDS)} s). When they answer they are talking to a voice agent of this mind, as in the voice app: the person's own agent (streamPath, /agents/voice/whatsapp-<their digits>), which keeps every call with them but not your conversation. It says \`opening\` first, and \`brief\` is all it knows about why you called, so put everything in it. A call FROM one of the same numbers to the agents' number is picked up the same way, once the voice is on the line; to say something particular when a person next rings, leave a note first: await itx.kv.put('whatsapp-calls/answer/<their digits>', JSON.stringify({ opening, brief, until })) (opening: what the voice says on picking up; brief: what the call's agent should know; until: an ISO time after which the note is ignored). One call at a time. hangup() ends it, status() answers the call in progress. Facts land on ${LOG_PATH} (whatsapp-calls/call-placed or call-received, call-answered, call-ended with direction, the transcript and the call's metrics); with reportTo (your own agent path) you are messaged what was said when a call you placed ends. It rings and answers only: ${numbers}.`,
      functions: ["call", "hangup", "status"],
    }),
  };
}

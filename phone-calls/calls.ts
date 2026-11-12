// calls.ts — real PHONE CALLS for an iterate mind, on its own phone number, both ways:
//
//   iterate provide phone-calls/calls.ts --name phoneCalls --mind <address>
//
// A copy of whatsapp-calls/calls.ts with a phone line in place of WhatsApp: the same calls, the
// same voice, the same records, so the two lends can be merged into one core later. OUT: the
// mind calls `itx.phoneCalls.call({ to, opening, brief, reportTo })` and the person's phone
// rings, from the mind's number. IN: a person this lend answers (PHONE_CALLS_ALLOWED) rings the
// number and the call is picked up; anyone else is turned away, to the number's own fallback
// (voicemail, or nothing). Either way the call is a voice call like any other the mind has, a
// press on the person's own voice device, `phone-<the other person's digits>`, provisioned once
// (for a person it answers, when the lend starts) and kept: its relay at `/voice/phone-<digits>`
// and its agent at `/agents/voice/phone-<digits>`, which keeps every call with that person. The
// person's words go up as microphone frames and the voice's answer comes back as speaker frames. The voice is on the line BEFORE the phone rings or the call
// is picked up.
//
// The line is `jeeves-phone serve` (serve.go: the number registered as a SIP phone with Andrews &
// Arnold), one process kept running, with the calls' audio on its stdin and stdout: the WhatsApp
// bridge's protocol, 16 kHz mono PCM16 both ways.
//
// A CALLER ID IS A CLAIM. Over the phone network a caller's number can be faked, so a call "from
// Jonas" may not be Jonas: the call's agent is told so, and a phone yes never approves money,
// deleting or messages to other people (that yes is asked for on WhatsApp). A caller the line
// itself marks untrusted (a free internet call, its number with a "?") never counts as anyone.
//
// The mind can leave a note for a caller's next call in its kv, at
// `phone-calls/answer/<the caller's digits>`, or WhatsApp's `whatsapp-calls/answer/<digits>`: JSON
// `{ opening?, brief?, until? }`, as on WhatsApp.
//
// One call at a time, across this lend and WhatsApp's: a call is not placed or picked up while
// `itx.whatsappCalls.status()` says one is in progress there, and this lend's own call is kept in
// kv `calls/busy` while it lasts, for the WhatsApp lend to read (it does not yet).
//
// The person's first words reach the agent at once, so a call keeps its agent ready from the moment
// the voice is on the line, before the phone rings, until it ends (`keepAgentReady`).
//
// Each call's facts land on /integrations/phone-calls: `phone-calls/call-placed` or
// `call-received`, `call-answered` (with the caller's agent path) and `call-ended` (with what was
// said), the WhatsApp lend's payloads.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connectVoiceDevice, type VoiceCall, type VoiceDevice } from "@iterate-com/voice/call";

export const description =
  "Phone calls on the agents' own number: call({ to, opening, brief, reportTo }) rings the person's phone and connects them to a voice agent that says `opening` and knows `brief`; a call from a known number to the agents' number is answered the same way; hangup(), status(). Call __describe() first.";

const LOG_PATH = "/integrations/phone-calls";
const BRIDGE = process.env.PHONE_CALLS_BIN || join(import.meta.dirname, "jeeves-phone");
/** How long the phone rings before the call is given up. */
const RING_SECONDS = 45;
/** How long a call lets its agent's model stay quiet before it asks the agent to get ready again:
 *  under the 60 s the agent's socket to the model stays open after a last answer. */
const AGENT_READY_EVERY_MS = 50_000;
/** The least time between two asks when a wait ends early, as it does on a lost link. */
const AGENT_RETRY_MS = 1_000;
const AGENT_WARM_UP = "events.iterate.com/agent/warm-up-requested";
/** The agent's model answering, for a request or a warm-up: its socket's 60 s start again. */
const AGENT_ANSWERED = [
  "events.iterate.com/agent/llm-request-settled",
  "events.iterate.com/agent/cache-kept-warm",
];
/** The numbers a call may be placed to, and whose calls are answered (digits with country code,
 *  comma-separated). */
const ALLOWED = new Set(
  (process.env.PHONE_CALLS_ALLOWED || "")
    .split(",")
    .map((number) => number.replace(/\D/g, ""))
    .filter(Boolean),
);
/** For a test only: the exact caller (the bridge's `from`, e.g. "?phonetest") of a test call that
 *  is picked up although it is nobody. Its call is recorded with `test: true` and reports to no one. */
const TEST_FROM = process.env.PHONE_CALLS_TEST_FROM || "";
/** What the voice says when it picks up, by the caller's digits: the WhatsApp lend's setting
 *  unless the phone has its own. */
const ANSWER_WITH: Record<string, string> = (() => {
  try {
    const parsed: unknown = JSON.parse(
      process.env.PHONE_CALLS_ANSWER_WITH || process.env.WHATSAPP_CALLS_ANSWER_WITH || "{}",
    );
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    console.error("phone-calls: PHONE_CALLS_ANSWER_WITH is not JSON; answering with Hello");
    return {};
  }
})();
/** Said after the opening of a call to anyone this lend does not answer (someone outside the
 *  household) when the line records its calls: "Please note that this call is recorded." Unset, nothing. */
const RECORDING_NOTICE = (process.env.PHONE_CALLS_RECORDING_NOTICE || "").trim();
/** Where this lend's call in progress is kept, for the other call lends. */
const BUSY_KEY = "calls/busy";

/** The mind, as `iterate provide` hands it over: the parts this file uses. */
type Mind = Parameters<typeof connectVoiceDevice>[0] & {
  agents: { get(path: string): { message(text: string): Promise<unknown> } };
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
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

/** What one call measured (whatsapp-calls/calls.ts's CallMetrics). */
type CallMetrics = {
  voiceReadyMs: number[];
  ringMs: number | null;
  micFramesSent: number;
  micFramesDropped: number;
  micFramesFailed: number;
  speakerChunks: number;
  speakerMs: number;
  voiceEnds: string[];
  /** The bridge's own count: frames (20 ms) played and heard, gaps in an answer, the deepest queue. */
  bridge: Record<string, number> | null;
  /** Times the lend's link to the mind was lost mid-call and the call carried over to the new one. */
  linkMoves: number;
};

/** A context of the mind's, as much of it as a voice device uses. */
type VoiceContext = ReturnType<Parameters<typeof connectVoiceDevice>[0]["cd"]>;
/** The call's agent, as `keepAgentReady` uses it. */
type AgentContext = {
  append(event: { type: string; payload: Record<string, never> }): Promise<unknown>;
  waitForEvent(filter: { type: string[]; timeoutMs: number }): Promise<unknown>;
};

/** `streamPath`: the caller's agent, `/agents/voice/phone-<digits>`, which keeps the call. */
type Placed = { callId: string; ringing: true; streamPath: string };

type ActiveCall = {
  /** "out": the mind rang the person. "in": the person rang the number. */
  direction: "out" | "in";
  callId: string;
  /** The other person's number, digits with country code ("" for a test caller). */
  number: string;
  /** The other person as recorded: "+44…", or a test caller as the line gave it. */
  who: string;
  /** A test call (PHONE_CALLS_TEST_FROM): recorded as such, reported to no one. */
  test: boolean;
  startedAt: number;
  ringingAt: number | null;
  answeredAt: number | null;
  opening: string | undefined;
  brief: string | undefined;
  reportTo: string | undefined;
  /** The caller's agent, which keeps this call and every one before it; null until the voice is
   *  connected. */
  agentPath: string | null;
  /** Every voice call the phone call was carried by, by activation: one, unless the voice was
   *  reconnected. */
  activations: string[];
  voice: VoiceCall | null;
  said: string[];
  metrics: CallMetrics;
  over: boolean;
  placed: PromiseWithResolvers<Placed> | null;
  noted: Promise<void> | null;
  /** THE GOODBYE BACKSTOP's state: whether the latest thing each side said was a goodbye, when the
   *  voice's queued answer ends, when the person last made a sound, and the pending hang-up. */
  personSaidBye: boolean;
  voiceSaidBye: boolean;
  voicePlaysUntil: number;
  personHeardAt: number;
  byeTimer: ReturnType<typeof setTimeout> | null;
  endedAfterGoodbyes: boolean;
};

/** A line of `jeeves-phone serve`'s stdout (serve.go). */
type BridgeEvent = {
  event?: string;
  callId?: string;
  pcm?: string;
  reason?: string;
  answered?: boolean;
  stats?: Record<string, number>;
  number?: string;
  from?: string;
  untrusted?: boolean;
  /** `ready`: the line's own number (PHONE_SIP_NUMBER) */
  self?: string;
  video?: boolean;
  group?: boolean;
};

let itx: Mind | undefined;
let active: ActiveCall | null = null;

/** Each caller's voice device, provisioned once (`itx.voice.ensureVoiceDevice`) and kept: a press
 *  on it is one append. A refused provisioning is asked again on the next call, or on the next
 *  reconnection for a caller this lend answers (provisionAnswered). */
const devices = new Map<string, Promise<VoiceDevice<VoiceContext>>>();
function deviceFor(mind: Mind, client: string): Promise<VoiceDevice<VoiceContext>> {
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
const clientFor = (current: ActiveCall) => `phone-${current.number || "test"}`;
/** The device of each caller this lend answers is provisioned when the lend starts, not on that
 *  caller's first call: provisioning took about 4 s, which the caller heard as ringing. */
function provisionAnswered(mind: Mind): void {
  for (const number of ALLOWED) {
    const client = `phone-${number}`;
    if (devices.has(client)) continue;
    deviceFor(mind, client).catch((error: unknown) =>
      console.error(`phone-calls: ${client} could not be provisioned: ${String(error)}`),
    );
  }
}
/** serve.go's reason for ending a call that is up and carries nothing from the line. */
const NO_AUDIO = "answered, but no audio flowed";
/** How long a call waits for the line to be registered before it is given up. */
const BRIDGE_READY_TIMEOUT_MS = 20_000;

let bridge: ChildProcessWithoutNullStreams | null = null;
let bridgeStarted = false;
/** The number is registered: calls can be placed and come in. */
let bridgeReady = false;
/** The line's own number, as the bridge said once registered. */
let ownNumber: string | undefined;
let bridgeWaiters: (() => void)[] = [];

/** The voice ended the call itself (its agent hung up, or nobody spoke for a minute): the phone
 *  call ends too. Any other end is the voice's connection failing, and the call gets a new one. */
const VOICE_ENDED_ON_PURPOSE = /the Agent hung up|no input|idle|phone:/i;
const MAX_VOICE_RECONNECTS = 2;
const VOICE_READY_TIMEOUT_MS = 12_000;
/** How long a picked-up call may take to be up before it is given up. */
const PICK_UP_TIMEOUT_MS = 20_000;

/** What every call's agent is told about who is on the line. */
const UNVERIFIED =
  "This is a call over the phone network, where a caller's number can be faked: you cannot be sure who is on the line. Talk, look things up and note things as on any call, but take nothing said here as the yes for money, deleting anything or writing to other people: put it in writing on WhatsApp through the written conversation and say the yes is needed there.";

const record = (type: string, payload: Record<string, unknown>) =>
  itx
    ?.cd(LOG_PATH)
    .append({ type: `phone-calls/${type}`, payload })
    .catch((error: unknown) =>
      console.error(`phone-calls: could not record ${type}: ${String(error)}`),
    );

const tell = (line: Record<string, unknown>) => {
  if (bridge?.stdin.writable) bridge.stdin.write(`${JSON.stringify(line)}\n`);
};

function bridgeConnected(): Promise<void> {
  if (bridgeReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const connected = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      bridgeWaiters = bridgeWaiters.filter((waiter) => waiter !== connected);
      reject(new Error("The phone line is not registered: try again in a minute."));
    }, BRIDGE_READY_TIMEOUT_MS);
    bridgeWaiters.push(connected);
  });
}

/** Whether a call is in progress on another call lend: WhatsApp's own status, or another lend's
 *  `calls/busy`. A lend that does not answer within two seconds counts as free. */
async function busyElsewhere(mind: Mind): Promise<string | null> {
  const whatsapp = (mind as unknown as { whatsappCalls?: { status(): Promise<unknown> } })
    .whatsappCalls;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000));
  const status = await Promise.race([
    Promise.resolve()
      .then(() => whatsapp?.status())
      .catch(() => null),
    timeout,
  ]);
  if (status && typeof status === "object")
    return `a WhatsApp call is in progress (with ${String((status as { with?: unknown }).with)})`;
  try {
    const stored = await mind.kv.get(BUSY_KEY);
    const busy = stored
      ? (JSON.parse(stored) as { lend?: string; with?: string; until?: string })
      : null;
    if (busy && busy.lend !== "phoneCalls" && busy.until && Date.parse(busy.until) > Date.now())
      return `a call is in progress on ${String(busy.lend)} (with ${String(busy.with)})`;
  } catch {
    // an unreadable flag blocks nothing
  }
  return null;
}

/** Keep this lend's call in kv `calls/busy` while it lasts (an hour at most, if this process dies). */
function markBusy(mind: Mind, current: ActiveCall): void {
  void mind.kv
    .put(
      BUSY_KEY,
      JSON.stringify({
        lend: "phoneCalls",
        with: current.who,
        direction: current.direction,
        since: new Date(current.startedAt).toISOString(),
        until: new Date(current.startedAt + 3_600_000).toISOString(),
      }),
    )
    .catch(() => undefined);
}

function clearBusy(mind: Mind): void {
  void mind.kv
    .get(BUSY_KEY)
    .then((stored) => {
      if (stored && (JSON.parse(stored) as { lend?: string }).lend === "phoneCalls")
        return mind.kv.delete(BUSY_KEY);
    })
    .catch(() => undefined);
}

const newCall = (
  direction: "out" | "in",
  number: string,
  who: string,
  test = false,
): ActiveCall => ({
  direction,
  callId: "",
  number,
  who,
  test,
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
    linkMoves: 0,
  },
  over: false,
  placed: null,
  noted: null,
  personSaidBye: false,
  voiceSaidBye: false,
  voicePlaysUntil: 0,
  personHeardAt: 0,
  byeTimer: null,
  endedAfterGoodbyes: false,
});

/** The mind's note for this caller's next call: the phone's own key, else WhatsApp's. */
async function takeNote(mind: Mind, current: ActiveCall): Promise<void> {
  if (!current.number) return;
  for (const key of [
    `phone-calls/answer/${current.number}`,
    `whatsapp-calls/answer/${current.number}`,
  ]) {
    try {
      const stored = await mind.kv.get(key);
      if (!stored) continue;
      const note = JSON.parse(stored) as { opening?: unknown; brief?: unknown; until?: unknown };
      if (typeof note.until === "string" && Date.parse(note.until) < Date.now()) continue;
      if (typeof note.opening === "string" && note.opening.trim()) current.opening = note.opening;
      if (typeof note.brief === "string" && note.brief.trim()) current.brief = note.brief;
      return;
    } catch (error) {
      console.error(`phone-calls: the note ${key} was not read: ${String(error)}`);
    }
  }
}

/** A goodbye, in what either side says. */
const GOODBYE =
  /\b(good-?bye|bye(-bye)?|cheerio|ta-ra|see (you|ya)|(speak|talk) (to you )?(soon|later)|good ?night)\b/i;
/** How long the line stays quiet after the voice's goodbye has played before the backstop hangs up. */
const GOODBYE_GRACE_MS = 2_500;
/** A microphone frame louder than this (mean absolute PCM16 sample) is the person making a sound. */
const PERSON_SOUND_LEVEL = 700;

/** THE GOODBYE BACKSTOP. The voice's model is told to end the call itself once goodbyes are said,
 *  and sometimes does not: on 2026-10-07 it said "Bye" back and stayed on the line until the
 *  person asked it to hang up. So once the latest thing each side said is a goodbye, the call is
 *  hung up when the voice's goodbye has played and the line has been quiet for a moment. Anything
 *  else either side says calls it off; a sound from the person puts it off. */
function armGoodbye(current: ActiveCall): void {
  if (current.byeTimer) clearTimeout(current.byeTimer);
  current.byeTimer = null;
  if (
    !current.personSaidBye ||
    !current.voiceSaidBye ||
    current.answeredAt === null ||
    current.over
  )
    return;
  const wait = Math.max(0, current.voicePlaysUntil - Date.now()) + GOODBYE_GRACE_MS;
  current.byeTimer = setTimeout(() => {
    current.byeTimer = null;
    if (current.over || !current.personSaidBye || !current.voiceSaidBye) return;
    if (Date.now() - current.personHeardAt < GOODBYE_GRACE_MS) return armGoodbye(current);
    console.error(`phone-calls: both sides said goodbye to ${current.who}; hanging up`);
    current.endedAfterGoodbyes = true;
    tell({ hangup: true });
  }, wait);
}

/** Mean absolute sample of a frame of 16-bit little-endian PCM, base64. */
function soundLevel(pcm: string): number {
  const bytes = Buffer.from(pcm, "base64");
  let sum = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) sum += Math.abs(bytes.readInt16LE(i));
  return bytes.length >= 2 ? sum / (bytes.length / 2) : 0;
}

/** The lend's link to the mind was lost and `iterate provide` reconnected: each caller's device
 *  moves to the new link, the call in progress with it, so it does not go silent. Jeeves's links are
 *  dropped every few minutes (the platform Worker's isolate is shed, 2026-10-07). */
function carryOver(mind: Mind): void {
  const current = active;
  if (current?.voice && !current.over) {
    current.metrics.linkMoves += 1;
    console.error(
      `phone-calls: the link was lost mid-call with ${current.who}; carrying the call over`,
    );
  }
  for (const [client, device] of devices) {
    // a call placed meanwhile waits for the move
    const moved = device.then(async (ready) => {
      await ready.moveTo(mind);
      return ready;
    });
    devices.set(client, moved);
    moved.catch((error: unknown) => {
      if (devices.get(client) === moved) devices.delete(client);
      if (active && !active.over && active.voice && clientFor(active) === client) {
        console.error(
          `phone-calls: the call could not be carried over (${String(error)}); hanging up`,
        );
        tell({ hangup: true });
      }
    });
  }
}

const addStats = (current: ActiveCall, ended: VoiceCall) => {
  current.metrics.micFramesSent += ended.stats.micFramesSent;
  current.metrics.micFramesDropped += ended.stats.micFramesDropped;
  current.metrics.micFramesFailed += ended.stats.micFramesFailed;
  current.metrics.speakerChunks += ended.stats.spkChunksReceived;
  current.metrics.speakerMs += Math.round(ended.stats.spkMsReceived);
};

/** A voice call of the mind's for this phone call, answered once the live model is on the line.
 *  `resumed`: the one before it failed mid-call, and this one is told what was said. */
async function connectVoice(mind: Mind, current: ActiveCall, resumed: boolean): Promise<void> {
  const pressedAt = Date.now();
  const device = await deviceFor(mind, clientFor(current));
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
      if (frame.clearSpeakerBufferBeforeFrame) {
        tell({ clear: true });
        current.voicePlaysUntil = Date.now();
      }
      if (frame.pcm) {
        tell({ pcm: frame.pcm, ...(frame.lastFrameOfAnswer && { last: true }) });
        // PCM16 at 16 kHz is 32 bytes a millisecond; base64 carries 3 bytes in every 4 characters
        const ms = (frame.pcm.replace(/=+$/, "").length * 3) / 4 / 32;
        current.voicePlaysUntil = Math.max(Date.now(), current.voicePlaysUntil) + ms;
        if (current.byeTimer) armGoodbye(current);
      } else if (frame.lastFrameOfAnswer) tell({ last: true });
    },
    onFact: (fact) => {
      if (fact.type === "events.iterate.com/voice-agent/conversation-accepted") accepted.resolve();
      if (fact.type === "events.iterate.com/voice-agent/provider-error-reported")
        console.error(
          `phone-calls: the live model reported: ${fact.payload.message.slice(0, 300)}`,
        );
      if (fact.type === "events.iterate.com/voice-agent/utterance-transcribed") {
        current.said.push(`Person: ${fact.payload.text}`);
        current.personSaidBye = GOODBYE.test(fact.payload.text);
        armGoodbye(current);
      }
      if (fact.type === "events.iterate.com/voice-agent/answer-transcribed") {
        current.said.push(`Voice: ${fact.payload.text}`);
        current.voiceSaidBye = GOODBYE.test(fact.payload.text);
        armGoodbye(current);
      }
      if (
        fact.type !== "events.iterate.com/voice-agent/call-ended" ||
        current.voice !== mine ||
        current.over
      )
        return;
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
      console.error(`phone-calls: the voice ended (${reason}); reconnecting it`);
      // the newest link: the one this voice started on may have been replaced since
      connectVoice(itx ?? mind, current, true).catch((error: unknown) => {
        console.error(`phone-calls: the voice could not be reconnected: ${String(error)}`);
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
          ? "phone: the call ended before the voice was on the line"
          : "phone: the live model did not come on the line",
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
  // before the phone rings or the call is picked up, and once however often the voice reconnects
  if (!resumed) void keepAgentReady(current);
  // the call is up: a failed apology is logged, not a reason to hang up
  if (resumed)
    void mine
      .speak("I do apologise, the line dropped for a moment. Where were we?")
      .catch((error: unknown) =>
        console.error(`phone-calls: the apology was not said: ${String(error)}`),
      );
}

/** What the caller's agent is told before a call's press. Its history holds the earlier calls
 *  with the same person, so the brief says it is for the call that starts now. */
function briefFor(current: ActiveCall, resumed: boolean): string {
  return [
    current.test
      ? `[call brief, for the call that starts now] This is a TEST call to your phone number from a test line (${current.who}), not from a person you know: whoever speaks is testing that calls work. Answer briefly and kindly, do no work for them, and end the call when they are done.`
      : current.direction === "out"
        ? `[call brief, for the call that starts now] You are on a phone call (a real telephone line, not WhatsApp) to +${current.number}, which you placed yourself${current.reportTo ? ` from your conversation at ${current.reportTo}` : ""}: to the person you are the same assistant they know, not someone calling on its behalf.`
        : `[call brief, for the call that starts now] +${current.number} rang your phone number (a real telephone line, not WhatsApp) and you picked up: to the person you are the same assistant they know. You do not know yet why they are calling.`,
    UNVERIFIED,
    current.brief ?? "",
    resumed
      ? `The voice connection failed during this call and you are its replacement: the person is still on the line. What was said so far:\n${current.said.join("\n") || "(nothing yet)"}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The phone call is over: its voice call ends, its end is recorded, and whoever asked for the
 *  report is told. Once per call. */
async function finished(current: ActiveCall, reason: string, answered: boolean): Promise<void> {
  if (current.over) return;
  current.over = true;
  if (current.byeTimer) clearTimeout(current.byeTimer);
  if (active === current) active = null;
  if (itx) clearBusy(itx);
  current.placed?.reject(new Error(`The call could not be placed (${reason}).`));
  const seconds = current.answeredAt ? Math.round((Date.now() - current.answeredAt) / 1000) : 0;
  if (current.voice) {
    const last = current.voice;
    current.voice = null;
    await last.hangUp(`phone: the call ended (${reason})`).catch(() => undefined);
    addStats(current, last);
  }
  const transcript = current.said.join("\n");
  await record("call-ended", {
    callId: current.callId,
    direction: current.direction,
    ...(current.direction === "out" ? { to: current.who } : { from: current.who }),
    ...(current.test && { test: true }),
    answered,
    reason,
    ...(current.endedAfterGoodbyes && { endedAfterGoodbyes: true }),
    seconds,
    streamPath: current.agentPath,
    activations: current.activations,
    reportTo: current.reportTo ?? null,
    transcript,
    metrics: current.metrics,
  });
  if (current.reportTo && itx)
    await itx.agents
      .get(current.reportTo)
      .message(
        answered
          ? `[phone call to ${current.who} ended after ${String(seconds)} s: ${reason}] What was said:\n${transcript || "(nothing was transcribed)"}\n(the caller's agent, with everything it did: ${current.agentPath ?? "none"})`
          : `[phone call to ${current.who} was not answered: ${reason}]`,
      )
      .catch((error: unknown) =>
        console.error(
          `phone-calls: could not report to ${String(current.reportTo)}: ${String(error)}`,
        ),
      );
}

/** The call's agent, on the newest link: the one the call started on may have been replaced. */
function agentOf(current: ActiveCall): AgentContext | undefined {
  return itx?.cd(current.agentPath!) as AgentContext | undefined;
}

/** Ask the call's agent for a warm-up: one ping, which leaves its context awake, its socket to the
 *  model open and its prompt cached. Failing costs a hand-over a second or two, never the call. */
async function askAgentToGetReady(current: ActiveCall): Promise<void> {
  await agentOf(current)
    ?.append({ type: AGENT_WARM_UP, payload: {} })
    .catch((error: unknown) =>
      console.error(`phone-calls: the agent was not asked to get ready: ${String(error)}`),
    );
}

/** Whether the agent's model answered within AGENT_READY_EVERY_MS. Its context sleeps about 10 s
 *  after its last call, so this wait, which stays open on the context, is what holds it awake. */
async function agentAnswers(current: ActiveCall): Promise<boolean> {
  const agent = agentOf(current);
  if (!agent) return false;
  try {
    await agent.waitForEvent({ type: AGENT_ANSWERED, timeoutMs: AGENT_READY_EVERY_MS });
    return true;
  } catch {
    return false;
  }
}

/** KEEP THE AGENT READY for as long as the call lasts. The voice hands the person's words over at
 *  once, and an agent that has gone quiet takes up to 2 s longer to start on them. A warm-up at the
 *  press is not enough: on real calls the first hand-over came 23 to 118 s after it. So one wait
 *  stays open on the agent, and each time 50 s pass with no answer from its model the agent is
 *  asked again, which also keeps its socket past the 60 s it would stay open. The agent does
 *  nothing with an ask while a request runs. */
async function keepAgentReady(current: ActiveCall): Promise<void> {
  await askAgentToGetReady(current);
  while (!current.over) {
    const waitedFrom = Date.now();
    if (await agentAnswers(current)) continue;
    if (current.over) return;
    const early = waitedFrom + AGENT_RETRY_MS - Date.now();
    if (early > 0) await new Promise((resolve) => setTimeout(resolve, early));
    await askAgentToGetReady(current);
  }
}

/** Ring `input.to`. The voice is connected FIRST, and only then does the phone ring. Answers once
 *  the phone is ringing; the rest is recorded on LOG_PATH and, with `reportTo`, told to that agent. */
async function call(input: CallInput): Promise<Placed> {
  const mind = itx;
  if (!mind) throw new Error("Phone calls are not connected to the mind yet.");
  const digits = String(input?.to ?? "").replace(/\D/g, "");
  if (digits.length < 8)
    throw new Error(
      `call({ to }) needs a phone number with its country code, got ${JSON.stringify(input?.to)}`,
    );
  // OUT: anyone (Jonas, 2026-10-07: "we should be able to call anyone"). Who is rung, and when, is
  // the agents' rules (calls.md); PHONE_CALLS_ALLOWED says only who is answered.
  if (active)
    throw new Error(`A call is already in progress (with ${active.who}): one call at a time.`);
  const elsewhere = await busyElsewhere(mind);
  if (elsewhere) throw new Error(`Not now: ${elsewhere}. One call at a time.`);
  // a call may have come in while WhatsApp was asked
  const meanwhile = active as ActiveCall | null;
  if (meanwhile)
    throw new Error(`A call is already in progress (with ${meanwhile.who}): one call at a time.`);

  const current = newCall("out", digits, `+${digits}`);
  current.opening = input.opening;
  current.brief = input.brief;
  // the lend says it, so the model cannot forget it
  if (RECORDING_NOTICE && !ALLOWED.has(digits)) {
    current.opening = [input.opening?.trim(), RECORDING_NOTICE].filter(Boolean).join(" ");
    current.brief = [
      input.brief,
      `This call is recorded, and your opening told them so ("${RECORDING_NOTICE}").`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  current.reportTo = input.reportTo;
  active = current;
  markBusy(mind, current);
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
  try {
    await bridgeConnected();
  } catch (error) {
    await finished(current, "the phone line is not registered", false);
    throw error;
  }
  current.placed = Promise.withResolvers<Placed>();
  tell({ call: `+${digits}`, ring: RING_SECONDS });
  return await current.placed.promise;
}

/** Someone is ringing the number. A caller this lend answers gets a voice call of the mind's
 *  first, and is picked up once the live model is on the line; anyone else is turned away, to the
 *  number's own fallback. */
async function incoming(event: BridgeEvent): Promise<void> {
  const mind = itx;
  const callId = event.callId ?? "";
  const digits = event.number ?? "";
  const test = Boolean(TEST_FROM) && event.from === TEST_FROM;
  const who = digits ? `+${digits}` : (event.from ?? "unknown");
  const turnAway = (reason: string) => {
    tell({ reject: callId });
    void record("call-received", {
      callId,
      from: who,
      ...(event.untrusted && { untrusted: true }),
      ...(test && { test: true }),
      answering: false,
      reason,
    });
  };
  if (!mind) return tell({ reject: callId });
  if (!test && (event.untrusted || !digits))
    return turnAway("the line does not vouch for the caller's number");
  if (!test && !ALLOWED.has(digits)) return turnAway("not a number this lend answers");
  if (active) return turnAway(`another call is in progress (with ${active.who})`);
  const current = newCall("in", test ? "" : digits, who, test);
  current.callId = callId;
  current.ringingAt = Date.now();
  active = current; // before any await: a second call is turned away
  const elsewhere = await busyElsewhere(mind);
  if (elsewhere) {
    active = null;
    return turnAway(elsewhere);
  }
  markBusy(mind, current);
  current.opening =
    (test ? ANSWER_WITH.test : ANSWER_WITH[digits]) ?? ANSWER_WITH.default ?? "Hello.";
  current.noted = takeNote(mind, current);
  void record("call-received", { callId, from: who, ...(test && { test: true }), answering: true });
  try {
    await connectVoice(mind, current, false);
  } catch (error) {
    tell({ reject: callId });
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
    void finished(current, "picked up, but the call never came up", false);
  }, PICK_UP_TIMEOUT_MS);
}

function onBridgeEvent(event: BridgeEvent): void {
  const current = active;
  if (event.event === "mic") {
    if (!event.pcm || !current) return;
    current.voice?.sendMicFrame(event.pcm);
    if (current.byeTimer && soundLevel(event.pcm) > PERSON_SOUND_LEVEL)
      current.personHeardAt = Date.now();
    return;
  }
  if (event.event === "ready") {
    bridgeReady = true;
    ownNumber = event.self ?? ownNumber;
    console.error("phone-calls: the number is registered");
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
      to: current.who,
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
  // an announced call this lend turned away ends too: only the call being carried is acted on
  if (event.callId !== current.callId) return;
  if (event.event === "answered") {
    current.answeredAt = Date.now();
    current.metrics.ringMs = current.ringingAt ? current.answeredAt - current.ringingAt : null;
    void record("call-answered", {
      callId: current.callId,
      direction: current.direction,
      ...(current.direction === "out" ? { to: current.who } : { from: current.who }),
      ...(current.test && { test: true }),
      streamPath: current.agentPath,
    });
    // ready by the time the opening ends, and the person answers it
    void askAgentToGetReady(current);
    // the voice is already on the line: it speaks first
    if (current.opening && current.voice)
      void current.voice
        .speak(current.opening)
        .catch((error: unknown) =>
          console.error(`phone-calls: the opening was not said: ${String(error)}`),
        );
    return;
  }
  if (event.event === "ended") {
    current.metrics.bridge = event.stats ?? null;
    if (event.reason === NO_AUDIO)
      console.error(`phone-calls: the call with ${current.who} carried no audio from the line`);
    void finished(current, event.reason ?? "ended", Boolean(event.answered));
  }
}

/** `jeeves-phone serve`, kept running: started again a few seconds after it exits. */
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
    console.error(`phone-calls: jeeves-phone exited (${String(code)}); starting it again in 5 s`);
    if (active)
      void finished(active, `the call process ended (${String(code)})`, active.answeredAt !== null);
    setTimeout(startBridge, 5000);
  });
}

export default async function provide(connection: { itx: Mind }) {
  const reconnected = itx !== undefined;
  itx = connection.itx;
  if (reconnected) carryOver(connection.itx);
  provisionAnswered(connection.itx);
  // `iterate provide` calls this again on each reconnection: the line stays as it is
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
            with: active.who,
            answered: active.answeredAt !== null,
            streamPath: active.agentPath,
          }
        : null;
    },
    __describe: () => ({
      instructions: `Phone calls on the agents' own number${ownNumber ? ` (${ownNumber})` : ""}, over the real phone network. call({ to, opening, brief, reportTo }) rings a person's phone: the voice is connected first, then the phone rings (it answers { callId, ringing, streamPath } once it does; the ring gives up after ${String(RING_SECONDS)} s). When they answer they are talking to a voice agent of this mind: the person's own agent (streamPath, /agents/voice/phone-<their digits>), which keeps every call with them but not your conversation. It says \`opening\` first, and \`brief\` is all it knows about why you called, so put everything in it. A call FROM one of the same numbers is picked up the same way; to say something particular when a person next rings, leave a note first: await itx.kv.put('phone-calls/answer/<their digits>', JSON.stringify({ opening, brief, until })) (WhatsApp's whatsapp-calls/answer/<digits> note is read too). A caller's number can be faked on the phone network: the call's agent is told the caller is unverified, and a yes for money, deleting or messages to others is asked for on WhatsApp. One call at a time, WhatsApp calls included. hangup() ends it, status() answers the call in progress. Facts land on ${LOG_PATH} (phone-calls/call-placed or call-received, call-answered, call-ended with direction, the transcript and the call's metrics); with reportTo (your own agent path) you are messaged what was said when a call you placed ends. It may ring anyone; it answers only ${numbers}.`,
      functions: ["call", "hangup", "status"],
    }),
  };
}

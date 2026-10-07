# Phone calls

Real phone calls between a person and an iterate project's voice agent, both ways, on the
project's own phone number: an [Andrews & Arnold](https://www.aa.net.uk) VoIP number, registered as
a SIP phone from your computer.

- **Out**: an agent calls `itx.phoneCalls.call({ to, opening, brief, reportTo })` and the person's
  phone rings, from the project's number.
- **In**: a person the lend answers rings the number, and the call is picked up. Anyone else is
  turned away, to the number's own fallback (voicemail, if the number has it).

It is [WhatsApp calls](../whatsapp-calls) with a phone line in place of WhatsApp: `calls.ts` is a
copy of that lend (the same calls, voice, notes and records, under `phone-calls/*`), and
`jeeves-phone serve` speaks that bridge's protocol on stdin and stdout. Each call is a context of
its own at `/agents/voice/phone-<the other person's digits>/<time>-<id>`, and the voice is on the
line before the phone rings or the call is picked up.

`jeeves-phone` is Go, on [sipgo](https://github.com/emiago/sipgo) and
[diago](https://github.com/emiago/diago): it registers the number with `voiceless.aa.net.uk`
(digest auth, again every 225 seconds, always at the one of its two servers it registered with: a
nonce from one is refused by the other), and carries G.711 A-law at 8 kHz, 20 ms a packet, to and
from 16 kHz PCM16 (`codec.go`: a 63-tap low-pass, then every other sample, and back).

**A caller ID is a claim.** On the phone network a caller's number can be faked. The lend still
answers only the numbers it was given, but the call's agent is told that it cannot be sure who is
on the line, so a project should never take a phone yes for money, deleting or writing to others.
A caller the line itself marks untrusted (a free call from the internet, see below) never counts
as any number.

## Run it

You need Go 1.25 or later, Node 22.18 or later, an `iterate` CLI with `provide`, a project with the
voice app installed (`itx.voice.setupVoiceAgent`), and this repository.

```sh
pnpm install
cd phone-calls && pnpm bridge                      # go build -o jeeves-phone .
export PHONE_SIP_NUMBER=+447700900000              # the number, in E.164: the SIP username
export PHONE_SIP_PASSWORD_FILE=~/.config/aa-sip-password   # a 0600 file with the number's password
export PHONE_CALLS_ALLOWED=447700900001,447700900002       # who may be rung, and whose calls are picked up
export PHONE_CALLS_ANSWER_WITH='{"447700900001":"At your service, sir.","default":"Hello."}'
iterate provide phone-calls/calls.ts --name phoneCalls --project <your project>
```

`PHONE_CALLS_ANSWER_WITH` falls back to `WHATSAPP_CALLS_ANSWER_WITH`. Keep it running with a loop,
as for [WhatsApp](../whatsapp#run-it). `serve`'s other settings (`PHONE_SIP_PORT`, 5062;
`PHONE_SIP_DOMAIN`; `PHONE_SIP_TRACE`, which logs every SIP message's first line by default) are
in `main.go`.

On the number's page at control.aa.net.uk: the target is **SIP phone**, no other target or
voicemail that answers before the lend does (it picks up five or six seconds in, once the voice is
on the line), and a low price cap on outgoing calls.

**Behind a NAT.** The line sends a call's ACK to the Contact of the answer and its audio to the
address in the SDP, so both must be the public address: `serve` asks `stun.aa.net.uk` for it when
it starts and checks it every five minutes (it exits when it changed, and the lend starts it
again). This needs a NAT that keeps a socket's port (most home routers do); `PHONE_SIP_EXTERNAL_HOST`
sets the address by hand.

## What the project gets

```js
const { callId, streamPath } = await itx.phoneCalls.call({
  to: "+44 7700 900001",
  opening: "Good evening, sir. The school has moved tomorrow's trip to nine o'clock.",
  brief:
    "Why you are calling and the facts the call's agent needs: it cannot see your conversation.",
  reportTo: "/agents/chief-of-staff", // messaged what was said once the call ends
}); // answers once the phone rings; the ring gives up after 45 s
await itx.phoneCalls.status(); // { direction, with, answered, streamPath } or null
await itx.phoneCalls.hangup();
```

A note for a caller's next call is kv `phone-calls/answer/<digits>` (else WhatsApp's
`whatsapp-calls/answer/<digits>`), `{ opening, brief, until }`. Every call leaves its facts on
`/integrations/phone-calls`: `phone-calls/call-placed`, `call-received` (with `untrusted` and
`reason` when the call was turned away), `call-answered` and `call-ended`, the WhatsApp lend's
payloads (`metrics.bridge` counts 20 ms frames).

One call at a time, WhatsApp's included: a call is not placed or picked up while
`itx.whatsappCalls.status()` has one, and this lend keeps its own in kv `calls/busy`.

## Test it without ringing anyone

Andrews & Arnold put a call to `sip:<number>@aa.org.uk` through to the number like any incoming
call, free, with the caller ID marked untrusted (`?` in front). `jeeves-phone dial` is such a
caller, with no account, so it can never place a call that costs anything:

```sh
say -o hello.wav --data-format=LEI16@8000 "Hello Jeeves, this is a test call, please just say hello back."
# start the lend with the test caller admitted (never leave it set): PHONE_CALLS_TEST_FROM='?phonetest'
./jeeves-phone dial sip:+447700900000@aa.org.uk hello.wav back.wav 30   # PHONE_DIAL_PLAY_AFTER=5
```

`back.wav` is what the voice said. The test call is recorded with `test: true`, its context is
`/agents/voice/phone-test/…`, and it reports to nobody. Andrews & Arnold's own codes test a
placed call for free: `{"call":"*105"}` on `serve`'s stdin rings the speaking clock.

```sh
pnpm test        # calls.ts over a pretend jeeves-phone and a pretend project
pnpm test:go     # the codec, the playout queue, and the bridge against a SIP peer on loopback
```

## Things to know

- **The phone does not ring when the lend is down.** A registration lasts ten minutes at the line;
  a process that stops unregisters itself, and a call then goes to the number's fallback.
- A call that is up and carries nothing from the line for six seconds is ended ("answered, but no
  audio flowed"), as is one whose line goes silent for twenty. It is not rung again, unlike WhatsApp.
- **A call survives a lost link.** When `iterate provide` reconnects mid-call, the call carries
  over: its microphone frames go over the new link, and its subscription resumes after the last
  fact it saw. The voice's audio from the gap (about a second) is lost. `call-ended` counts the
  moves as `metrics.linkMoves`.
- **Goodbyes end the call.** The voice is told to hang up once goodbyes are said, and sometimes
  does not. When the latest thing each side said is a goodbye, the lend hangs up 2.5 s after the
  voice's goodbye has played, unless the person makes a sound; `call-ended` then has
  `endedAfterGoodbyes: true`.
- **A recorded line says so.** With `PHONE_CALLS_RECORDING_NOTICE` set (for example "Please note
  that this call is recorded."), a placed call to a number the lend does not answer opens with it,
  and the call's agent is told. Household numbers (`PHONE_CALLS_ALLOWED`) hear no notice.
- DTMF (keys pressed) arrives and is logged, nothing more.

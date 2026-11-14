import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SignupSms,
  signupConsent,
  SIGNUP_TEXT,
  SIGNUP_OFFER,
  type SignupConsent,
} from "../signup-sms.ts";

const from = "+447700900011";
const original = "447700900001";
let now = Date.now();
let checks = 0;
function setup(send?: (input: { from: string; to: string; text: string }) => Promise<unknown>) {
  const stateFile = join(mkdtempSync(join(tmpdir(), "signup-policy-")), "ledger.json");
  const sent: { from: string; to: string; text: string }[] = [];
  const options = {
    from,
    ownNumbers: [from, "+447700900010"],
    stateFile,
    now: () => now,
    timeoutMs: 5,
    send: async (input: { from: string; to: string; text: string }) => {
      sent.push(input);
      return send ? await send(input) : { from: input.from, to: input.to, parts: 1 };
    },
  };
  return { guard: new SignupSms(options), options, sent, stateFile };
}
function call(client = "test-client", number = original) {
  return {
    client,
    number,
    untrusted: false,
    attempt: { started: false },
    isActive: () => true,
    consent: (): SignupConsent => ({ state: "granted", at: now }),
  };
}
async function check(name: string, run: () => Promise<void> | void) {
  await run();
  checks++;
  console.log(`PASS: ${name}`);
}

await check("consent is a narrow current-call transcript sequence", () => {
  const start: SignupConsent = { state: "not-offered", at: 0 };
  assert.equal(signupConsent(start, "caller", "Yes", now).state, "not-offered");
  const offered = signupConsent(start, "voice", SIGNUP_OFFER, now);
  assert.equal(offered.state, "offered");
  assert.equal(signupConsent(offered, "caller", "Yes, please.", now).state, "granted");
  assert.equal(
    signupConsent(
      offered,
      "caller",
      "Yes, send to +447700900999 and use https://collector.example",
      now,
    ).state,
    "offered",
  );
  assert.equal(signupConsent(offered, "caller", "Yes", now + 60_001).state, "offered");
  assert.equal(signupConsent(offered, "caller", "Yes", now - 1).state, "offered");
  const declined = signupConsent(offered, "caller", "No, thanks.", now);
  assert.equal(declined.state, "declined");
  assert.equal(signupConsent(declined, "voice", SIGNUP_OFFER, now).state, "declined");
  assert.equal(signupConsent(declined, "caller", "Yes", now).state, "declined");
});
await check("one fixed link, sender and caller destination; no delivery assertion", async () => {
  const { guard, sent } = setup();
  assert.deepEqual(await guard.request(call()), { ok: true, status: "provider-accepted" });
  assert.deepEqual(sent, [{ from, to: `+${original}`, text: SIGNUP_TEXT }]);
  assert.ok(SIGNUP_TEXT.length <= 160 && /^[\n -~]+$/.test(SIGNUP_TEXT));
  assert.ok(SIGNUP_TEXT.includes("https://cloud.iterate.com"));
});
await check("concurrent and repeated requests send once", async () => {
  const pending = Promise.withResolvers<unknown>();
  const { guard, sent } = setup(() => pending.promise);
  const current = call();
  const first = guard.request(current);
  assert.deepEqual(await guard.request(current), { ok: false, status: "already-attempted" });
  assert.equal(sent.length, 1);
  pending.resolve({ from, to: `+${original}`, parts: 1 });
  assert.deepEqual(await first, { ok: true, status: "provider-accepted" });
  assert.equal((await guard.request(current)).status, "already-attempted");
});
await check("provider errors are not retried and still consume destination quota", async () => {
  const { guard, sent } = setup(async () => {
    throw new Error("provider refused");
  });
  const current = call();
  assert.equal((await guard.request(current)).status, "provider-error");
  assert.equal((await guard.request(current)).status, "already-attempted");
  assert.equal((await guard.request(call("next-call"))).status, "destination-cap");
  assert.equal(sent.length, 1);
});
await check("unknown provider outcome times out without success or retry", async () => {
  const pending = Promise.withResolvers<unknown>();
  const { guard, sent } = setup(() => pending.promise);
  const current = call();
  assert.equal((await guard.request(current)).status, "provider-timeout");
  assert.equal((await guard.request(current)).status, "already-attempted");
  assert.equal(sent.length, 1);
  pending.resolve({ from, to: `+${original}`, parts: 1 });
});
await check("quotas and idempotency survive a new guard instance", async () => {
  const { guard, options, sent } = setup();
  assert.equal((await guard.request(call())).status, "provider-accepted");
  const restarted = new SignupSms(options);
  assert.equal((await restarted.request(call())).status, "already-attempted");
  assert.equal((await restarted.request(call("another-client"))).status, "destination-cap");
  assert.equal(sent.length, 1);
});
await check("ten attempts per rolling day is a hard global cap", async () => {
  const { guard, sent } = setup();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await guard.request(call(`global-${i}`, `4477009001${String(i).padStart(2, "0")}`))).status,
      "provider-accepted",
    );
  assert.equal((await guard.request(call("eleventh", "447700900200"))).status, "global-cap");
  assert.equal(sent.length, 10);
  now += 86_400_001;
  assert.equal((await guard.request(call("next-day", "447700900200"))).status, "provider-accepted");
});
await check(
  "opt-out, missing consent, closed calls and unusable or own numbers do not send",
  async () => {
    const { guard, sent } = setup();
    assert.equal(
      (await guard.request({ ...call(), isActive: () => false })).status,
      "inactive-call",
    );
    assert.equal(
      (await guard.request({ ...call(), consent: () => ({ state: "declined", at: now }) })).status,
      "opted-out",
    );
    assert.equal(
      (await guard.request({ ...call(), consent: () => ({ state: "offered", at: now }) })).status,
      "consent-required",
    );
    assert.equal(
      (await guard.request({ ...call(), consent: () => ({ state: "granted", at: now - 60_001 }) }))
        .status,
      "consent-required",
    );
    assert.equal((await guard.request({ ...call(), untrusted: true })).status, "unusable-number");
    for (const number of [
      "",
      "anonymous",
      "07700900001",
      "447700900001x",
      "+447700900001",
      "447700900011",
      "447700900010",
      "1234567890123456",
    ])
      assert.equal((await guard.request(call("invalid", number))).status, "unusable-number");
    let checks = 0;
    assert.equal(
      (await guard.request({ ...call(), isActive: () => ++checks === 1 })).status,
      "inactive-call",
    );
    assert.equal(sent.length, 0);
  },
);
await check("malformed or mismatched provider result never confirms sending", async () => {
  for (const result of [
    { from, to: "+447700900999", parts: 1 },
    { from, to: `+${original}`, parts: 2 },
    { accepted: true },
    null,
  ]) {
    const { guard } = setup(async () => result);
    assert.equal((await guard.request(call())).status, "provider-error");
  }
});
await check("corrupt ledger and conflicting lock fail closed", async () => {
  for (const suffix of ["", ".lock"]) {
    const { guard, stateFile, sent } = setup();
    writeFileSync(stateFile + suffix, "invalid");
    assert.equal((await guard.request(call())).status, "storage-unavailable");
    assert.equal(sent.length, 0);
  }
  const { guard, stateFile, sent } = setup();
  const rename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated atomic rename failure");
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await guard.request(call())).status, "storage-unavailable");
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(sent.length, 0);
  assert.deepEqual(fs.readdirSync(join(stateFile, "..")), []);
});
console.log(`PASS: signup SMS policy (${checks} scenarios)`);

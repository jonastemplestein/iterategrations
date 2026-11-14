import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const SIGNUP_URL = "https://cloud.iterate.com";
export const SIGNUP_TEXT = `Your official Iterate signup link: ${SIGNUP_URL}\nCreate your own mind in your own Cloudflare account.`;
export const SIGNUP_OFFER = "May I text the signup link to the number you're calling from?";
export const SIGNUP_CONFIRMATION = "I have just texted you a link.";
export const SIGNUP_DAILY_CAP = 10;
const DAY_MS = 86_400_000;
const CONSENT_MS = 60_000;

export type SignupConsent = {
  state: "not-offered" | "offered" | "granted" | "declined";
  at: number;
};
export type SignupSmsResult =
  | { ok: true; status: "provider-accepted" }
  | {
      ok: false;
      status:
        | "consent-required"
        | "opted-out"
        | "inactive-call"
        | "unusable-number"
        | "already-attempted"
        | "destination-cap"
        | "global-cap"
        | "storage-unavailable"
        | "provider-error"
        | "provider-timeout";
    };

function speech(text: string): string {
  return text
    .normalize("NFKC")
    .replaceAll("’", "'")
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Consent comes from actual voice/caller transcript facts, never from a delegated instruction. */
export function signupConsent(
  previous: SignupConsent,
  speaker: "voice" | "caller",
  text: string,
  now: number,
): SignupConsent {
  const said = speech(text);
  if (speaker === "voice") {
    if (
      (previous.state === "not-offered" || previous.state === "offered") &&
      said.endsWith(speech(SIGNUP_OFFER))
    )
      return { state: "offered", at: now };
    return previous;
  }
  if (
    /^(no(?:,? (?:thanks|thank you))?|stop|cancel|please don't|don't text me|do not text me)$/.test(
      said,
    )
  )
    return { state: "declined", at: now };
  if (previous.state !== "offered" || now < previous.at || now - previous.at > CONSENT_MS)
    return previous;
  if (/^(yes(?:,? please|,? (?:please )?send (?:me )?the link)?|please do|go ahead)$/.test(said))
    return { state: "granted", at: now };
  return previous;
}

const Ledger = z.strictObject({
  version: z.literal(1),
  attempts: z
    .array(
      z.strictObject({
        client: z.string().min(1).max(64),
        destination: z.string().regex(/^[a-f0-9]{64}$/),
        at: z.number().int().positive(),
      }),
    )
    .max(32),
});

type SmsInput = { from: string; to: string; text: string };
type Options = {
  from: string;
  ownNumbers: readonly string[];
  stateFile: string;
  now(): number;
  timeoutMs: number;
  send(input: SmsInput): Promise<unknown>;
};
type Request = {
  client: string;
  number: string;
  untrusted: boolean;
  attempt: { started: boolean };
  isActive(): boolean;
  consent(): SignupConsent;
};

export class SignupSms {
  readonly #options: Options;
  constructor(options: Options) {
    this.#options = options;
  }

  /** Reserve before the non-idempotent provider call. Errors and uncertain outcomes consume quota. */
  #reserve(client: string, number: string, now: number): SignupSmsResult | null {
    const path = this.#options.stateFile;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    const lock = openSync(lockPath, "wx", 0o600);
    try {
      const ledger = existsSync(path)
        ? Ledger.parse(JSON.parse(readFileSync(path, "utf8")))
        : { version: 1 as const, attempts: [] };
      const attempts = ledger.attempts.filter((attempt) => attempt.at >= now - DAY_MS);
      const destination = createHash("sha256").update(number).digest("hex");
      if (attempts.some((attempt) => attempt.client === client))
        return { ok: false, status: "already-attempted" };
      if (attempts.some((attempt) => attempt.destination === destination))
        return { ok: false, status: "destination-cap" };
      if (attempts.length >= SIGNUP_DAILY_CAP) return { ok: false, status: "global-cap" };
      attempts.push({ client, destination, at: now });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(file, JSON.stringify({ version: 1, attempts }));
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
        renameSync(temporary, path);
        const directory = openSync(dirname(path), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      return null;
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }

  async request(call: Request): Promise<SignupSmsResult> {
    if (!call.isActive()) return { ok: false, status: "inactive-call" };
    const consent = call.consent();
    if (consent.state === "declined") return { ok: false, status: "opted-out" };
    const now = this.#options.now();
    if (consent.state !== "granted" || now - consent.at > CONSENT_MS || consent.at > now)
      return { ok: false, status: "consent-required" };
    const to = `+${call.number}`;
    if (
      call.untrusted ||
      !/^[1-9]\d{7,14}$/.test(call.number) ||
      to === this.#options.from ||
      this.#options.ownNumbers.includes(to) ||
      !/^\+[1-9]\d{7,14}$/.test(this.#options.from)
    )
      return { ok: false, status: "unusable-number" };
    if (call.attempt.started) return { ok: false, status: "already-attempted" };
    call.attempt.started = true;
    try {
      const refusal = this.#reserve(call.client, to, now);
      if (refusal) return refusal;
    } catch {
      return { ok: false, status: "storage-unavailable" };
    }
    if (!call.isActive() || call.consent().state !== "granted")
      return { ok: false, status: "inactive-call" };
    const timeout = Symbol("provider-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.#options.send({ from: this.#options.from, to, text: SIGNUP_TEXT }),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), this.#options.timeoutMs);
        }),
      ]);
      if (result === timeout) return { ok: false, status: "provider-timeout" };
      z.object({
        from: z.literal(this.#options.from),
        to: z.literal(to),
        parts: z.literal(1),
      }).parse(result);
      return { ok: true, status: "provider-accepted" };
    } catch {
      return { ok: false, status: "provider-error" };
    } finally {
      clearTimeout(timer);
    }
  }
}

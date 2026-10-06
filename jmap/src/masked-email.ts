/**
 * Fastmail's Masked Email (https://www.fastmail.com/for-developers/masked-email/): throwaway
 * addresses that deliver to the account's mailbox, each made for one site and switched off or deleted
 * when it is no longer wanted. A JMAP extension: capability `https://www.fastmail.com/dev/maskedemail`
 * (the token needs that scope), methods `MaskedEmail/get` and `MaskedEmail/set`.
 *
 * States: `pending` (new; Fastmail deletes it 24 hours after it is made unless mail arrives, which
 * enables it), `enabled` (delivers), `disabled` (mail goes to the trash), `deleted` (mail bounces).
 */
import { z } from "zod";
import { JmapError, type Jmap } from "./jmap.js";

export const MASKED_EMAIL = "https://www.fastmail.com/dev/maskedemail";

export type MaskedEmailState = "pending" | "enabled" | "disabled" | "deleted";

export type MaskedEmail = {
  id: string;
  email: string;
  state: MaskedEmailState;
  /** The site it was made for: protocol and domain, as given at creation. */
  forDomain: string;
  description: string;
  lastMessageAt: string | null;
  createdAt: string;
  createdBy: string;
  url: string | null;
};

export type CreateMaskedEmail = {
  /** The site it is for, e.g. `https://example.com`. */
  forDomain: string;
  /** Why it exists, in a few words. */
  description: string;
  /** The address's start, when wanted: at most 64 of a-z, 0-9 and `_`. */
  emailPrefix?: string;
  /** `enabled` (default here: delivers at once, and stays until it is deleted) or `pending`
   *  (Fastmail deletes it after 24 hours unless mail arrives). */
  state?: "enabled" | "pending";
};

const MaskedEmailSchema = z.object({
  id: z.string(),
  email: z.string(),
  state: z.enum(["pending", "enabled", "disabled", "deleted"]),
  forDomain: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  description: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  lastMessageAt: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  createdBy: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  url: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
});

const EmailPrefix = z
  .string()
  .regex(/^[a-z0-9_]{1,64}$/, "emailPrefix: at most 64 of a-z, 0-9 and _");

const SetErrorSchema = z.object({ type: z.string(), description: z.string().optional() });

/** The account's masked addresses, by the connected JMAP client. */
export class MaskedEmails {
  readonly #jmap: Jmap;

  constructor(jmap: Jmap) {
    this.#jmap = jmap;
  }

  /** Every masked address of the account, deleted ones included. */
  async list(): Promise<MaskedEmail[]> {
    const result = await this.#jmap.method([MASKED_EMAIL], "MaskedEmail/get", {
      accountId: this.#jmap.accountFor(MASKED_EMAIL),
    });
    return z.array(MaskedEmailSchema).parse(result.list);
  }

  /** A new masked address for one site. */
  async create(input: CreateMaskedEmail): Promise<MaskedEmail> {
    const emailPrefix =
      input.emailPrefix === undefined ? undefined : EmailPrefix.parse(input.emailPrefix);
    const result = await this.#jmap.method([MASKED_EMAIL], "MaskedEmail/set", {
      accountId: this.#jmap.accountFor(MASKED_EMAIL),
      create: {
        new: {
          state: input.state ?? "enabled",
          forDomain: input.forDomain,
          description: input.description,
          ...(emailPrefix ? { emailPrefix } : {}),
        },
      },
    });
    const failure = SetErrorSchema.safeParse(
      (result.notCreated as Record<string, unknown> | undefined)?.new,
    );
    if (failure.success)
      throw new JmapError("MaskedEmail/set", failure.data.type, failure.data.description);
    const created = z
      .object({ id: z.string(), email: z.string() })
      .passthrough()
      .parse((result.created as Record<string, unknown> | undefined)?.new);
    // the server answers the properties it set; the rest are what was asked
    return MaskedEmailSchema.parse({
      state: input.state ?? "enabled",
      forDomain: input.forDomain,
      description: input.description,
      createdAt: new Date().toISOString(),
      ...created,
    });
  }

  /** Switch an address on (`enabled`), off (`disabled`: mail to the trash) or delete it
   *  (`deleted`: mail bounces). */
  async setState(id: string, state: "enabled" | "disabled" | "deleted"): Promise<void> {
    const result = await this.#jmap.method([MASKED_EMAIL], "MaskedEmail/set", {
      accountId: this.#jmap.accountFor(MASKED_EMAIL),
      update: { [id]: { state } },
    });
    const failure = SetErrorSchema.safeParse(
      (result.notUpdated as Record<string, unknown> | undefined)?.[id],
    );
    if (failure.success)
      throw new JmapError("MaskedEmail/set", failure.data.type, failure.data.description);
  }
}

/** The account's masked addresses: `maskedEmails(await connectJmap({ … }))`. */
export function maskedEmails(jmap: Jmap): MaskedEmails {
  return new MaskedEmails(jmap);
}

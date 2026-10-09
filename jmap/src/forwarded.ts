/** A header as JMAP's `headers` property gives it. */
export type Header = { name: string; value: string };
/** The mailbox's own copy of a message, as `fastmailCopies` reads it. */
export type FastmailCopy = { from: string; subject: string; text: string; headers: Header[] };
/** A mail the mailbox forwarded, as the platform recorded it (`events.iterate.com/email/received`). */
export type ForwardedMail = {
  messageId: string | null;
  from: string;
  subject: string;
  text: string | null;
};
export type FastmailVerdict = { verified: boolean; reason: string };

/** Fastmail's servers, which seal its ARC sets. */
const SEALER = "messagingengine.com";
/** A mail with more ARC sets than this is not believed. */
const MAX_INSTANCE = 10;

const words = (text: string) => text.replace(/\s+/g, " ").trim();
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const fastmailHost = (host: string | undefined) =>
  !!host && (host === SEALER || host.endsWith(`.${SEALER}`));
const aligned = (domain: string | undefined, from: string) =>
  !!domain && (domain === from || domain.endsWith(`.${from}`) || from.endsWith(`.${domain}`));
const named = (headers: Header[], name: string) =>
  headers.filter((header) => header.name.toLowerCase() === name).map((header) => header.value);

/** An ARC header's `tag=value` pairs (`i`, `d`, …). */
function tags(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length >= 2)
      .map(([key, ...rest]) => [key!.trim().toLowerCase(), rest.join("=").trim()]),
  );
}

/** An ARC-Authentication-Results value: its instance, its host (authserv-id), and each result. */
function arcResults(value: string) {
  const parts = value
    .replace(/\([^()]*\)/g, " ")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const instance = Number(/^i\s*=\s*(\d+)$/i.exec(parts[0] ?? "")?.[1] ?? NaN);
  const host = (parts[1] ?? "").split(/\s+/)[0]!.toLowerCase();
  const results = parts.slice(2).map((part) => {
    const [verdict = "", ...properties] = part.toLowerCase().split(/\s+/);
    const [method, outcome] = verdict.split("=");
    const pairs = properties.map((property) => property.split("="));
    return { method, outcome, properties: Object.fromEntries(pairs) as Record<string, string> };
  });
  return { instance, host, results };
}

/** Whether Fastmail's own check says a forwarded mail's From is genuine. Fastmail checked the sender
 *  when the mail reached the mailbox, and its copy says so: an ARC set on top of the message,
 *  `ARC-Seal: i=N; d=messagingengine.com`, whose `ARC-Authentication-Results` gives the From
 *  domain's DMARC and DKIM results. Every copy (`fastmailCopies`, read with the mailbox's own token,
 *  since the platform does not keep a forwarded mail's headers) must match the mail (From, Subject,
 *  the start of the text) and carry Fastmail's pass for the From domain: a DMARC pass, or a DKIM pass
 *  aligned with it. Only Fastmail's set counts: the first ARC-Authentication-Results, of the highest
 *  instance, from a messagingengine.com host, with an ARC-Seal of that instance from
 *  d=messagingengine.com. A sender's own results, or ARC sets it wrote, sit below Fastmail's and are
 *  never read. The seal's signature is not checked: the copy comes from Fastmail itself. */
export function fastmailVerdict(mail: ForwardedMail, copies: FastmailCopy[]): FastmailVerdict {
  if (!mail.messageId) return { verified: false, reason: "it has no Message-ID to find" };
  if (copies.length === 0) return { verified: false, reason: "it is not in the mailbox" };
  const from = domainOf(mail.from);
  for (const copy of copies) {
    const sameText =
      !mail.text || !copy.text || words(copy.text).slice(0, 500) === words(mail.text).slice(0, 500);
    if (
      copy.from.toLowerCase() !== mail.from.toLowerCase() ||
      words(copy.subject) !== words(mail.subject) ||
      !sameText
    )
      return { verified: false, reason: "it differs from the mailbox's copy" };
    const sets = named(copy.headers, "arc-authentication-results").map(arcResults);
    const top = sets[0];
    const highest = Math.max(...sets.map((set) => set.instance).filter(Number.isFinite));
    const seal = named(copy.headers, "arc-seal")
      .map(tags)
      .find((seal) => Number(seal.i) === top?.instance);
    if (
      !top ||
      top.instance !== highest ||
      top.instance > MAX_INSTANCE ||
      !fastmailHost(top.host) ||
      seal?.d?.toLowerCase() !== SEALER
    )
      return { verified: false, reason: "Fastmail's own check is not on top of it" };
    const passed = top.results.some(
      ({ method, outcome, properties }) =>
        outcome === "pass" &&
        ((method === "dmarc" && aligned(properties["header.from"], from)) ||
          (method === "dkim" && aligned(properties["header.d"], from))),
    );
    if (!passed) {
      const dmarc = top.results.find(({ method }) => method === "dmarc");
      const header = dmarc?.properties["header.from"];
      const said = dmarc ? `dmarc=${dmarc.outcome}${header ? ` for ${header}` : ""}` : "no dmarc";
      return {
        verified: false,
        reason: `Fastmail's check did not pass for ${from} (${said}, no dkim pass for it)`,
      };
    }
  }
  return { verified: true, reason: `Fastmail's check passed for ${from}` };
}

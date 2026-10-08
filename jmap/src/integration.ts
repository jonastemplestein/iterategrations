/** The project, as the card needs it: what a config worker's `itx` already has. */
export type JmapItx = {
  secrets: { list(): Promise<{ path: string }[]> };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. The mailbox has no host of its own, so no
 *  `routingSlug` and no `fetch`. */
export type Integration = {
  routingSlug?: string;
  processEvent?(args: { event: IntegrationEvent; itx: JmapItx }): Promise<void>;
};

/** The token, as the recipe's step 1 collects it. */
const TOKEN = "/secrets/fastmail";

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets the
 *  mailbox up by the recipe, so the card links there, and it is "ok" once the token exists. */
const cardOf = (token: boolean) => ({
  title: "Mailbox (JMAP)",
  description:
    "The project's own Fastmail mailbox, over JMAP: agents send from it, search it, read whole threads and make Masked Email addresses, calling Fastmail's API with fetch and the token's placeholder.",
  status: token
    ? { kind: "ok" }
    : { kind: "attention", text: "Set up by your coding agent: see the recipe" },
  actions: [
    { label: "Recipe", url: "https://github.com/jonastemplestein/iterategrations/tree/main/jmap" },
  ],
});

/** The project's mailbox on the Dash, as an integration its worker hosts:
 *  `const integrations: Integration[] = [jmap()];`
 *
 *  Its install hook (`project/worker-updated`) lists the mailbox on the Dash's Integrations page.
 *  That is all it does: agents and the project's code call Fastmail's JMAP API with `fetch` and the
 *  token's placeholder, as the README says. */
export function jmap(): Integration {
  return {
    async processEvent({ event, itx }) {
      if (event.type !== WORKER_UPDATED) return;
      const token = (await itx.secrets.list()).some((secret) => secret.path === TOKEN);
      // The platform retries an event, so this card may have landed already, perhaps with what was
      // true then (IDEMPOTENCY_CONFLICT): not an error, and the next publish registers it again.
      await itx
        .cd("/integrations")
        .append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `jmap:registry:${event.path}@${event.offset}`,
          payload: { integration: "jmap", card: cardOf(token) },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
        });
    },
  };
}

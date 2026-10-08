// Runs against dist (the package as shipped): `pnpm test` builds first. The package is the Dash's
// card and nothing else, so this is its install hook against a pretend project.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { jmap } from "../dist/index.js";

test("jmap() has no host of its own; its install hook registers the card, keyed by the event's path and offset, ok once the token exists", async () => {
  const appended: { path: string; event: any }[] = [];
  const secrets: string[] = [];
  const itx: any = {
    secrets: { list: async () => secrets.map((path) => ({ path })) },
    cd: (path: string) => ({
      append: async (event: any) => {
        const earlier = appended.find((a) => a.event.idempotencyKey === event.idempotencyKey);
        if (earlier && JSON.stringify(earlier.event) === JSON.stringify(event)) return;
        if (earlier) throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
  };
  const integration = jmap();
  assert.equal(integration.routingSlug, undefined);
  assert.equal("fetch" in integration, false);
  const publish = (offset: number, type = "events.iterate.com/project/worker-updated") =>
    integration.processEvent!({ event: { type, path: "/", offset }, itx });
  const card = (status: object) => ({
    title: "Mailbox (JMAP)",
    description:
      "The project's own Fastmail mailbox, over JMAP: agents send from it, search it, read whole threads and make Masked Email addresses, calling Fastmail's API with fetch and the token's placeholder.",
    status,
    actions: [
      {
        label: "Recipe",
        url: "https://github.com/jonastemplestein/iterategrations/tree/main/jmap",
      },
    ],
  });

  for (let attempt = 0; attempt < 2; attempt++) await publish(5);
  secrets.push("/secrets/fastmail");
  await publish(5); // the same event again, now with the token: its key is spent, and that is fine
  await publish(6);
  await publish(7, "events.iterate.com/itx/woken"); // every other event is ignored
  assert.deepEqual(appended, [
    {
      path: "/integrations",
      event: {
        type: "events.iterate.com/integration/configured",
        idempotencyKey: "jmap:registry:/@5",
        payload: {
          integration: "jmap",
          card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
        },
      },
    },
    {
      path: "/integrations",
      event: {
        type: "events.iterate.com/integration/configured",
        idempotencyKey: "jmap:registry:/@6",
        payload: { integration: "jmap", card: card({ kind: "ok" }) },
      },
    },
  ]);
});

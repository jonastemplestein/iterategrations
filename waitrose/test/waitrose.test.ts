// Runs against dist (the package as shipped): `pnpm test` builds first. `fakeWaitrose` puts a
// pretend Waitrose behind the global `fetch`, which is the project's egress in a loaded worker: it
// answers each request by its URL or its GraphQL operation, and records every request it was sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "vite-plus/test";
import { EXCHANGE_SOURCE, exchange } from "../dist/exchange.js";
import {
  CheckoutOutcomeUnknownError,
  OPERATIONS,
  graphql,
  placeOrder,
  waitrose,
  waitroseFetch,
} from "../dist/index.js";

const AUTHORIZATION = 'Bearer getSecret("/secrets/waitrose", { field: "accessToken" })';
const ORIGIN = "https://waitrose--iterate.example";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/waitrose";
const USER_AGENT = "Waitrose/3.9.1 (Android)";
const GRAPHQL_URL = "https://www.waitrose.com/api/graphql-prod/graph/live";
const PLACE_URL = "https://www.waitrose.com/api/order-orchestration-prod/v1/orders/o-1/place";
const CONTEXT = {
  customerId: "c-1",
  customerOrderId: "o-1",
  customerOrderState: "TROLLEY",
  defaultBranchId: "b-1",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  init: RequestInit;
};

/** Waitrose behind the global `fetch`: `answer` gets each request's URL and GraphQL operation name,
 *  and what it leaves unanswered is HTTP 500. */
function fakeWaitrose(
  answer: (url: string, operation?: string) => Response | Promise<Response> | undefined,
) {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
      init,
    });
    const operation = /^(?:query|mutation) (\w+)/.exec(body?.query ?? "")?.[1];
    return (await answer(request.url, operation)) ?? new Response("no answer", { status: 500 });
  }) as typeof fetch;
  return sent;
}

// ------------------------------------------- the helpers

test("waitroseFetch is the global fetch with the token's placeholder, the app's user agent and JSON: content-type only with a body, and the caller's headers win", async () => {
  const sent = fakeWaitrose(() => Response.json({}));
  await waitroseFetch("https://www.waitrose.com/api/products-prod/v1/products/1+2?view=EXTENDED");
  await waitroseFetch(new URL("https://www.waitrose.com/api/somewhere"), {
    method: "POST",
    headers: { accept: "text/plain", "x-trace": "t-1" },
    body: '{"a":1}',
    redirect: "manual",
  });
  assert.equal(
    sent[0]!.url,
    "https://www.waitrose.com/api/products-prod/v1/products/1+2?view=EXTENDED",
  );
  assert.equal(sent[0]!.method, "GET");
  assert.deepEqual(sent[0]!.headers, {
    accept: "application/json",
    authorization: AUTHORIZATION,
    "user-agent": USER_AGENT,
  });
  assert.equal(sent[1]!.method, "POST");
  assert.deepEqual(sent[1]!.body, { a: 1 });
  assert.equal(sent[1]!.init.redirect, "manual");
  assert.deepEqual(sent[1]!.headers, {
    accept: "text/plain",
    authorization: AUTHORIZATION,
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-trace": "t-1",
  });
});

test("graphql posts the operation and its variables to Waitrose's GraphQL endpoint through waitroseFetch, and returns data", async () => {
  const sent = fakeWaitrose(() => Response.json({ data: { getTrolley: { failures: null } } }));
  assert.deepEqual(await graphql(OPERATIONS.GetTrolley, { orderId: "o-1" }), {
    getTrolley: { failures: null },
  });
  await graphql(OPERATIONS.GetCampaigns);
  assert.equal(sent[0]!.url, GRAPHQL_URL);
  assert.equal(sent[0]!.method, "POST");
  assert.deepEqual(sent[0]!.body, { query: OPERATIONS.GetTrolley, variables: { orderId: "o-1" } });
  assert.equal(sent[0]!.headers.authorization, AUTHORIZATION);
  assert.equal(sent[0]!.headers["user-agent"], USER_AGENT);
  assert.equal(sent[0]!.headers["content-type"], "application/json");
  assert.deepEqual(sent[1]!.body.variables, {});
});

test("graphql throws on an HTTP error and on GraphQL errors, with their messages; a refusal inside data is the caller's to read", async () => {
  fakeWaitrose(() => new Response("down", { status: 503 }));
  await assert.rejects(graphql(OPERATIONS.GetShoppingContext), { message: "HTTP 503: down" });
  fakeWaitrose(() =>
    Response.json({ data: null, errors: [{ message: "Bad orderId" }, { message: "Not found" }] }),
  );
  await assert.rejects(graphql(OPERATIONS.GetTrolley, { orderId: "x" }), {
    message: "GraphQL Error: Bad orderId, Not found",
  });
  const refused = { bookSlot: { failures: [{ type: "SLOT_GONE", message: "Slot taken" }] } };
  fakeWaitrose(() => Response.json({ data: refused, errors: [] }));
  assert.deepEqual(
    await graphql(OPERATIONS.BookSlot, { input: { slotId: "s-1", slotType: "DELIVERY" } }),
    refused,
  );
});

test("OPERATIONS is the app's 17 GraphQL operations, frozen, each under its own name", () => {
  assert.ok(Object.isFrozen(OPERATIONS));
  assert.equal(Object.keys(OPERATIONS).length, 17);
  for (const [name, text] of Object.entries(OPERATIONS))
    assert.match(text, new RegExp(`^(query|mutation) ${name}\\b`));
});

test("the README's script calls Waitrose as the package does: the same request as graphql(OPERATIONS.GetShoppingContext)", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const script = readme.split("### The helpers in a script")[1]?.match(/```js\n([\s\S]*?)```/)?.[1];
  assert.ok(script, "README has no script under 'The helpers in a script'");
  const run = (
    await import(`data:text/javascript,${encodeURIComponent(`export default ${script}`)}`)
  ).default;
  const sent = fakeWaitrose((_, operation) =>
    operation === "GetShoppingContext"
      ? Response.json({ data: { shoppingContext: CONTEXT } })
      : undefined,
  );
  assert.deepEqual(await run(), CONTEXT);
  await graphql(OPERATIONS.GetShoppingContext);
  const [fromScript, fromPackage] = sent.map(({ url, method, headers, body }) => ({
    url,
    method,
    headers,
    body,
  }));
  assert.deepEqual(fromScript, fromPackage);
});

// ------------------------------------------- placeOrder

const SLOT = {
  slotType: "DELIVERY",
  startDateTime: "2026-10-10T09:00:00Z",
  endDateTime: "2026-10-10T10:00:00Z",
  expiryDateTime: new Date(Date.now() + 3_600_000).toISOString(),
};
const PLACED = {
  customerOrderId: "o-1",
  totals: { estimated: { totalPrice: { amount: 87.45, currencyCode: "GBP" } }, actual: null },
  slots: [
    {
      branchId: 1,
      branchName: "Anytown",
      type: "DELIVERY",
      startDateTime: SLOT.startDateTime,
      endDateTime: SLOT.endDateTime,
    },
  ],
};
const REVIEWED = { orderId: "o-1", expectedTotal: { amount: 87.45, currencyCode: "GBP" } };

/** A Waitrose whose current order, o-1, is ready for instant checkout at £87.45, less what `change`
 *  alters. `place` answers the place POST. */
function checkoutWaitrose(
  change: {
    context?: object;
    trolley?: (trolley: any) => void;
    slot?: object | null;
    place?: () => Response | Promise<Response>;
  } = {},
) {
  const trolley = {
    instantCheckout: "ALLOWED",
    checkoutReadiness: { slotTypeValid: true },
    failures: null,
    products: [],
    trolley: {
      orderId: "o-1",
      trolleyItems: [{ lineNumber: "123", quantity: { amount: 1, uom: "C62" } }],
      trolleyTotals: {
        minimumSpendThresholdMet: true,
        trolleyItemCounts: { hardConflicts: 0, noConflicts: 1, softConflicts: 0 },
        totalEstimatedCost: { amount: 87.45, currencyCode: "GBP" },
      },
    },
  };
  change.trolley?.(trolley);
  const slot = "slot" in change ? change.slot : SLOT;
  const sent = fakeWaitrose((url, operation) => {
    if (operation === "GetShoppingContext")
      return Response.json({ data: { shoppingContext: { ...CONTEXT, ...change.context } } });
    if (operation === "GetTrolley") return Response.json({ data: { getTrolley: trolley } });
    if (operation === "CurrentSlot") return Response.json({ data: { currentSlot: slot } });
    if (url === PLACE_URL) return change.place ? change.place() : Response.json(PLACED);
  });
  return { sent, placed: () => sent.filter((request) => request.url === PLACE_URL) };
}

test("placeOrder reviews the checkout from fresh reads, then posts once to the place endpoint and returns Waitrose's answer", async () => {
  const waitroseSide = checkoutWaitrose();
  assert.deepEqual(await placeOrder(REVIEWED), PLACED);
  const [first, ...rest] = waitroseSide.sent;
  assert.equal(first!.body.query, OPERATIONS.GetShoppingContext);
  const reads = Object.fromEntries(
    rest.filter((request) => request.body?.query).map((r) => [r.body.query, r.body.variables]),
  );
  assert.deepEqual(reads, {
    [OPERATIONS.GetTrolley]: { orderId: "o-1" },
    [OPERATIONS.CurrentSlot]: { input: { customerOrderId: "o-1" } },
  });
  const placed = waitroseSide.placed();
  assert.equal(placed.length, 1);
  assert.equal(waitroseSide.sent.at(-1), placed[0]);
  assert.equal(placed[0]!.method, "POST");
  assert.deepEqual(placed[0]!.body, { instantCheckout: true, event: "PLACE" });
  assert.equal(placed[0]!.headers.authorization, AUTHORIZATION);
  assert.equal(placed[0]!.headers["user-agent"], USER_AGENT);
  assert.equal(placed[0]!.headers["content-type"], "application/json");
  assert.equal(placed[0]!.init.redirect, "manual");
  assert.ok(placed[0]!.init.signal instanceof AbortSignal);
});

test("placeOrder refuses when the estimated total is not the one the person agreed to, and posts nothing", async () => {
  for (const expectedTotal of [
    { amount: 80, currencyCode: "GBP" },
    { amount: 87.45, currencyCode: "EUR" },
  ]) {
    const { placed } = checkoutWaitrose();
    await assert.rejects(placeOrder({ orderId: "o-1", expectedTotal }), {
      message: "The estimated total has changed; review checkout again",
    });
    assert.equal(placed().length, 0);
  }
});

test("placeOrder refuses when the trolley is not the current order, and posts nothing", async () => {
  const { placed } = checkoutWaitrose({
    trolley: (trolley) => {
      trolley.trolley.orderId = "o-2";
    },
  });
  await assert.rejects(placeOrder(REVIEWED), {
    message: "Checkout blocked: The trolley does not match the current order",
  });
  assert.equal(placed().length, 0);
});

test("placeOrder refuses unless instant checkout is ALLOWED, and posts nothing", async () => {
  for (const [instantCheckout, shown] of [
    ["NOT_ALLOWED", "NOT_ALLOWED"],
    ["THRESHOLD_EXCEEDED", "THRESHOLD_EXCEEDED"],
    [undefined, "unknown"],
  ]) {
    const { placed } = checkoutWaitrose({
      trolley: (trolley) => {
        trolley.instantCheckout = instantCheckout;
      },
    });
    await assert.rejects(placeOrder(REVIEWED), {
      message: `Checkout blocked: Instant checkout is ${shown}; complete payment setup or checkout on the Waitrose website`,
    });
    assert.equal(placed().length, 0);
  }
});

test("placeOrder names every other blocker, and posts nothing", async () => {
  const cases: [Parameters<typeof checkoutWaitrose>[0], string][] = [
    [
      { trolley: (t) => void (t.failures = [{ type: "X", message: "x" }]) },
      "Waitrose reported trolley failures",
    ],
    [
      { trolley: (t) => void (t.checkoutReadiness.slotTypeValid = false) },
      "A valid delivery or collection slot is required",
    ],
    [{ slot: null }, "A valid delivery or collection slot is required"],
    [{ slot: { ...SLOT, slotType: "VAN" } }, "A valid delivery or collection slot is required"],
    [
      { slot: { ...SLOT, expiryDateTime: "2020-01-01T00:00:00Z" } },
      "The slot reservation has expired or its expiry is unknown",
    ],
    [{ trolley: (t) => void (t.trolley.trolleyItems = []) }, "The trolley is empty"],
    [
      { trolley: (t) => void (t.trolley.trolleyTotals.minimumSpendThresholdMet = false) },
      "The minimum spend requirement is not met or unknown",
    ],
    [
      { trolley: (t) => void (t.trolley.trolleyTotals.trolleyItemCounts.hardConflicts = 1) },
      "Resolve trolley conflicts before checkout",
    ],
    [
      { trolley: (t) => void (t.trolley.trolleyTotals.totalEstimatedCost = null) },
      "The estimated total is unavailable",
    ],
  ];
  for (const [change, blocker] of cases) {
    const { placed } = checkoutWaitrose(change);
    await assert.rejects(placeOrder(REVIEWED), { message: `Checkout blocked: ${blocker}` });
    assert.equal(placed().length, 0);
  }
});

test("placeOrder refuses bad arguments before any request, and a changed or missing current order before it reads the trolley", async () => {
  const { sent } = checkoutWaitrose();
  for (const bad of [
    { orderId: "o 1", expectedTotal: { amount: 87.45, currencyCode: "GBP" } },
    { orderId: "o-1", expectedTotal: { amount: -1, currencyCode: "GBP" } },
    { orderId: "o-1", expectedTotal: { amount: Number.NaN, currencyCode: "GBP" } },
    { orderId: "o-1", expectedTotal: { amount: 87.45, currencyCode: "" } },
    { orderId: "o-1" },
  ])
    await assert.rejects(placeOrder(bad as typeof REVIEWED), {
      message: "A reviewed order ID and expected total/currency are required",
    });
  assert.equal(sent.length, 0);
  for (const [customerOrderId, message] of [
    ["o-2", "The current order has changed; review checkout again"],
    [null, "No current order available for checkout"],
  ]) {
    const changed = checkoutWaitrose({ context: { customerOrderId } });
    await assert.rejects(placeOrder(REVIEWED), { message });
    assert.deepEqual(
      changed.sent.map((request) => request.body?.query),
      [OPERATIONS.GetShoppingContext],
    );
  }
});

test("an unclear answer to the place POST is CheckoutOutcomeUnknownError, and the POST is never sent again", async () => {
  const unclear: (() => Response | Promise<Response>)[] = [
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    () => new Response("", { status: 500 }),
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 408 }),
    () => new Response("<html>", { status: 200 }),
    () => Response.json({ ...PLACED, customerOrderId: "o-2" }),
    () => Response.json({ ...PLACED, totals: [] }),
    () => Response.json({ ...PLACED, slots: null }),
  ];
  for (const place of unclear) {
    const { placed } = checkoutWaitrose({ place });
    const error = await placeOrder(REVIEWED).catch((error: unknown) => error);
    assert.ok(error instanceof CheckoutOutcomeUnknownError);
    assert.equal(error.orderId, "o-1");
    assert.equal(
      error.message,
      "Checkout outcome is unknown for order o-1. Check getOrder before retrying; the order may have been placed.",
    );
    assert.equal(placed().length, 1);
  }
});

test("a refusal of the place POST (HTTP 4xx) says so, and is not an unknown outcome", async () => {
  const { placed } = checkoutWaitrose({ place: () => new Response("", { status: 409 }) });
  const error = await placeOrder(REVIEWED).catch((error: unknown) => error);
  assert.ok(error instanceof Error && !(error instanceof CheckoutOutcomeUnknownError));
  assert.equal(
    error.message,
    "Waitrose checkout rejected (409). Check the order and checkout eligibility before retrying.",
  );
  assert.equal(placed().length, 1);
});

// ------------------------------------------- the login, as the secret's refresh

test("exchange logs in without any Authorization header and returns the material with the accessToken", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const material = { username: "ada@example.com", password: "hunter2" };
  const result = await exchange(material, async (url, init = {}) => {
    seen.push({ url, init });
    return Response.json({ data: { generateSession: { accessToken: "jwt-1", failures: null } } });
  });
  assert.deepEqual(result, { ...material, accessToken: "jwt-1" });
  const [{ url, init }] = seen;
  assert.equal(url, "https://www.waitrose.com/api/graphql-prod/graph/live");
  const headers = Object.fromEntries(
    Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
  assert.equal(headers.authorization, undefined);
  assert.match(headers["user-agent"]!, /^Waitrose\//);
  assert.deepEqual(JSON.parse(init.body as string).variables.input, {
    clientId: "ANDROID_APP",
    password: "hunter2",
    username: "ada@example.com",
  });
});

test("exchange refusals name the fix and never the credential", async () => {
  const material = { username: "ada@example.com", password: "hunter2" };
  const answering = (response: Response) => async () => response;
  await assert.rejects(
    exchange(material, answering(new Response("", { status: 401 }))),
    /HTTP 401.*username and password/,
  );
  await assert.rejects(
    exchange(material, answering(new Response("", { status: 520 }))),
    /HTTP 520/,
  );
  await assert.rejects(
    exchange(
      material,
      answering(
        Response.json({ data: { generateSession: { failures: [{ type: "BAD_LOGIN" }] } } }),
      ),
    ),
    /BAD_LOGIN/,
  );
  await assert.rejects(
    exchange(material, answering(Response.json({ data: null }))),
    /no accessToken/,
  );
  await assert.rejects(
    exchange({ username: "ada@example.com" }, answering(Response.json({}))),
    /no "username" and "password"/,
  );
  for (const attempt of [
    exchange(material, answering(new Response("", { status: 401 }))),
    exchange(
      material,
      answering(
        Response.json({ data: { generateSession: { failures: [{ type: "BAD_LOGIN" }] } } }),
      ),
    ),
  ])
    await attempt.catch((error: Error) =>
      assert.doesNotMatch(error.message, /hunter2|ada@example/),
    );
});

test("EXCHANGE_SOURCE is a module exporting the same exchange", async () => {
  const shipped = await import(`data:text/javascript,${encodeURIComponent(EXCHANGE_SOURCE)}`);
  const result = await shipped.exchange({ username: "u", password: "p" }, async () =>
    Response.json({ data: { generateSession: { accessToken: "jwt-2" } } }),
  );
  assert.deepEqual(result, { username: "u", password: "p", accessToken: "jwt-2" });
});

test("the README's exchange block is the shipped EXCHANGE_SOURCE, less its export", async () => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(
    readme.includes(EXCHANGE_SOURCE.replace(/^export /, "export ")),
    "README is out of date: paste EXCHANGE_SOURCE",
  );
});

// ------------------------------------------- the card on the Dash

test("waitrose() answers the waitrose routing slug; its install hook registers the card, keyed by the event's path and offset, ok once the account's secret exists", async () => {
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
  const integration = waitrose();
  assert.equal(integration.routingSlug, "waitrose");
  assert.equal(typeof integration.fetch, "function");
  const publish = (offset: number, type = "events.iterate.com/project/worker-updated") =>
    integration.processEvent!({ event: { type, path: "/", offset }, itx });
  const card = (status: object) => ({
    title: "Waitrose",
    description:
      "The Waitrose grocery API (search, trolley, orders, delivery slots, checkout), signed in as the person's own account: agents and the project's code call it with fetch and the token's placeholder.",
    icon: "https://www.google.com/s2/favicons?domain=waitrose.com&sz=64",
    status,
    actions: [
      { label: "Open", routingSlug: "waitrose", path: "/" },
      { label: "Recipe", url: RECIPE },
    ],
  });

  for (let attempt = 0; attempt < 2; attempt++) await publish(5);
  secrets.push("/secrets/waitrose");
  await publish(5); // the same event again, now with the secret: its key is spent, and that is fine
  await publish(6);
  await publish(7, "events.iterate.com/itx/woken"); // every other event is ignored
  assert.deepEqual(appended, [
    {
      path: "/integrations",
      event: {
        type: "events.iterate.com/integration/configured",
        idempotencyKey: "waitrose:registry:/@5",
        payload: {
          integration: "waitrose",
          card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
        },
      },
    },
    {
      path: "/integrations",
      event: {
        type: "events.iterate.com/integration/configured",
        idempotencyKey: "waitrose:registry:/@6",
        payload: { integration: "waitrose", card: card({ kind: "ok" }) },
      },
    },
  ]);
});

// ------------------------------------------- the page

/** The worker hosting the package, over a project with `secrets`: a scope per `getItx`, counted, and
 *  a member gate that refuses unless `member` is set. */
function hosted(secrets: string[], options: { member?: boolean } = {}) {
  const scopes = { opened: 0, disposed: 0 };
  const integration = waitrose();
  const serve = (request: Request) =>
    integration.fetch!(request, {
      getItx: () => {
        scopes.opened++;
        const itx: any = { secrets: { list: async () => secrets.map((path) => ({ path })) } };
        return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
      },
      auth: {
        require: () => (options.member ? null : new Response("Sign in\n", { status: 401 })),
      },
    });
  const page = (path: string) => serve(new Request(`${ORIGIN}${path}`));
  return { scopes, serve, page };
}

test("the page is for members: a non-member gets what auth.require answers, and nothing is read", async () => {
  const project = hosted(["/secrets/waitrose"]);
  for (const path of ["/", "/nope"]) {
    const res = await project.page(path);
    assert.equal(res.status, 401, path);
    assert.equal(await res.text(), "Sign in\n");
  }
  assert.deepEqual(project.scopes, { opened: 0, disposed: 0 });
});

test("the page shows the status: until the account's secret exists, what to paste into a coding agent, with a Copy button", async () => {
  const sent = fakeWaitrose(() => undefined);
  let res = await hosted([], { member: true }).page("/");
  let html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /<h1>Waitrose<\/h1>/);
  assert.match(html, /Set up by your coding agent: see the recipe/);
  const hint = `Set up Waitrose in my iterate project. Follow the recipe at ${RECIPE}`;
  assert.ok(html.includes(`data-copy="${hint}"`), hint);
  assert.ok(html.includes(`href="${RECIPE}"`));

  const project = hosted(["/secrets/waitrose"], { member: true });
  res = await project.page("/");
  html = await res.text();
  assert.match(
    html,
    /Set up\. The project has the Waitrose account <code>\/secrets\/waitrose<\/code>/,
  );
  assert.doesNotMatch(html, /coding agent|data-copy="/);
  assert.deepEqual(project.scopes, { opened: 1, disposed: 1 });
  assert.deepEqual(sent, []); // the page never calls Waitrose
});

test("the page sends a CSP with its one nonce'd script, no form, and no frame, and X-Frame-Options DENY", async () => {
  const res = await hosted([], { member: true }).page("/");
  const html = await res.text();
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
  assert.equal(html.match(/<script/g)!.length, 1);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.doesNotMatch(html, /onclick=|<form/);
});

test("a member's stray path is a 404 that reads nothing", async () => {
  const project = hosted(["/secrets/waitrose"], { member: true });
  for (const path of ["/nope", "/webhook", "/oauth2/callback"])
    assert.equal((await project.page(path)).status, 404, path);
  assert.equal((await project.serve(new Request(`${ORIGIN}/`, { method: "POST" }))).status, 404);
  assert.deepEqual(project.scopes, { opened: 0, disposed: 0 });
});

// Runs against dist (the package as shipped): `pnpm test` builds first. `fakeArbor` puts a pretend
// Arbor behind the global `fetch`, which is the project's egress in a loaded worker: it answers each
// request by its URL, and records every request it was sent. Every name, school and ID here is
// made up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "vite-plus/test";
import { EXCHANGE_SOURCE, exchange } from "../dist/exchange.js";
import {
  arbor,
  checkoutBasket,
  CheckoutOutcomeUnknownError,
  chooseMeals,
  moneyOf,
  readBasket,
  removeMealChoices,
  arborFetch,
  arborGet,
  arborUrl,
  attributesOf,
  fieldValues,
  findNodes,
  readForm,
  submitForm,
  textOf,
} from "../dist/index.js";

const AUTHORIZATION = 'Bearer getSecret("/secrets/arbor", { field: "accessToken" })';
const ORIGIN = "https://arbor--iterate.example";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/arbor";
const SITE = "https://example-primary.uk.arbor.education";
const APP_HEADERS = {
  accept: "application/json",
  "arbor-client": "Mobile",
  authorization: AUTHORIZATION,
  "mobile-app-version": "0.22.0",
  "user-agent": "okhttp/4.12.0",
  "x-pci-compliant": "yes",
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

/** Arbor behind the global `fetch`: `answer` gets each request's URL, and what it leaves
 *  unanswered is HTTP 500. */
function fakeArbor(answer: (url: string) => Response | Promise<Response> | undefined) {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      init,
    });
    return (await answer(request.url)) ?? new Response("no answer", { status: 500 });
  }) as typeof fetch;
  return sent;
}

/** A page as Arbor sends it to the app: a tree of named components. */
const node = (
  name: string,
  attributes: Record<string, unknown> | unknown[] = [],
  children: any[] = [],
  content: string | null = null,
) => ({ name, attributes, children, content });

/** A meal choice form for one week, as the app gets it: two days, three options each. */
const MEAL_FORM = node("slide-over", { title: "Meal Choices" }, [
  node("section", { title: "Add Meal Choice" }, [
    node("form-action", {
      name: "process-meal-provisions",
      url: "/guardians/basket/process-meal-provisions/meal-rotation-menu-id/9/start-date/2030-01-07/end-date/2030-01-11",
    }),
    node("form-action", {
      name: "delete-meal-provisions",
      url: "/guardians/basket-item/delete-meal-provisions/",
    }),
    node(
      "form-field-hidden",
      {
        targetField: "student",
        value: { value: "1_42_0", label: "Sam Example", group: "Student" },
      },
      [node("form-field-action", { formActionName: "process-meal-provisions" })],
    ),
    node("form-field-hidden", {
      targetField: "basketItems",
      formActionName: "delete-meal-provisions",
      value: [],
    }),
    node(
      "form-field-combobox",
      { targetField: "meal_provision_1893974400", label: "Mon, 07 Jan 2030" },
      [
        node(
          "form-field-combobox-option",
          { selected: "1", value: "7_1" },
          [],
          "Pasta Bake - &pound;2.50",
        ),
        node(
          "form-field-combobox-option",
          { selected: "", value: "7_2" },
          [],
          "Jacket Potato - £2.50",
        ),
        node("form-field-combobox-option", { selected: "", value: "" }, [], "No choice selected"),
        node("form-field-action", { formActionName: "process-meal-provisions" }),
      ],
    ),
    node(
      "form-field-combobox",
      { targetField: "meal_provision_1894060800", label: "Tue, 08 Jan 2030" },
      [
        node("form-field-combobox-option", { selected: "", value: "7_1" }, [], "Fish Pie"),
        node("form-field-combobox-option", { selected: "", value: "" }, [], "No choice selected"),
        node("form-field-action", { formActionName: "process-meal-provisions" }),
      ],
    ),
  ]),
  node("action-panel", { dock: "true" }, [
    node("button", {
      formActionName: "process-meal-provisions",
      label: "Process",
      role: "form-action",
    }),
  ]),
]);

// ------------------------------------------- the fetch helpers

test("arborFetch is the global fetch with the token's placeholder and the app's headers: content-type only with a body, and the caller's headers win", async () => {
  const sent = fakeArbor(() => Response.json({}));
  await arborFetch(`${SITE}/guardians/home-ui/dashboard`);
  await arborFetch(new URL(`${SITE}/somewhere`), {
    method: "POST",
    headers: { accept: "text/plain", "x-trace": "t-1" },
    body: '{"a":1}',
  });
  assert.equal(sent[0]!.url, `${SITE}/guardians/home-ui/dashboard`);
  assert.equal(sent[0]!.method, "GET");
  assert.deepEqual(sent[0]!.headers, APP_HEADERS);
  assert.equal(sent[1]!.method, "POST");
  assert.deepEqual(sent[1]!.body, { a: 1 });
  assert.deepEqual(sent[1]!.headers, {
    ...APP_HEADERS,
    accept: "text/plain",
    "content-type": "application/json",
    "x-trace": "t-1",
  });
});

test("arborUrl puts each path shape Arbor's pages give on the site, and leaves a full URL as it is", () => {
  for (const site of [SITE, `${SITE}/`, ` ${SITE}// `])
    for (const path of [
      "/guardians/my-mis-ui/my-basket",
      "guardians/my-mis-ui/my-basket",
      "/?/guardians/my-mis-ui/my-basket",
    ])
      assert.equal(
        arborUrl(site, path).href,
        `${SITE}/guardians/my-mis-ui/my-basket`,
        `${site} ${path}`,
      );
  assert.equal(
    arborUrl(SITE, "/guardians/x?format=javascript").href,
    `${SITE}/guardians/x?format=javascript`,
  );
  assert.equal(arborUrl(SITE, "https://other.example/a").href, "https://other.example/a");
});

test("arborGet GETs the path on the site through arborFetch and returns the JSON, a page or a data envelope", async () => {
  const page = node("page", [], [node("column-title", [], [], "Hello")]);
  const sent = fakeArbor((url) =>
    url.endsWith("/dashboard")
      ? new Response(JSON.stringify(page), {
          headers: { "content-type": "text/html; charset=UTF-8" },
        })
      : Response.json({ items: [{ fields: { badge: { value: 2 } } }], success: true }),
  );
  assert.deepEqual(await arborGet(SITE, "/guardians/home-ui/dashboard"), page);
  assert.deepEqual(await arborGet(`${SITE}/`, "guardians/data"), {
    items: [{ fields: { badge: { value: 2 } } }],
    success: true,
  });
  assert.equal(sent[0]!.url, `${SITE}/guardians/home-ui/dashboard`);
  assert.deepEqual(sent[0]!.headers, APP_HEADERS);
});

test("arborGet throws on an HTTP error with Arbor's message as plain text, on success: false, and on an answer that is no JSON", async () => {
  fakeArbor(() =>
    Response.json(
      {
        success: false,
        message: "<h3>Sorry, we can&#039;t find this page</h3>\n<p>Try again.</p>",
      },
      { status: 404 },
    ),
  );
  await assert.rejects(arborGet(SITE, "/nope"), {
    message: "HTTP 404: Sorry, we can't find this page Try again.",
  });
  fakeArbor(() =>
    Response.json(
      { code: "API-AUTHENTICATION-REQUIRED", message: "Authentication required." },
      { status: 401 },
    ),
  );
  await assert.rejects(arborGet(SITE, "/x"), { message: "HTTP 401: Authentication required." });
  fakeArbor(() => Response.json({ success: false, message: "Not allowed" }));
  await assert.rejects(arborGet(SITE, "/x"), { message: "Arbor refused: Not allowed" });
  fakeArbor(() => new Response("<html>maintenance</html>"));
  await assert.rejects(arborGet(SITE, "/x"), /^Error: Arbor answered no JSON: maintenance/);
});

test("submitForm posts { fields: { name: { value } } } once to the action with format=json, and returns Arbor's answer, refusals included", async () => {
  const answer = {
    success: false,
    action_params: { validation_errors: { message: ["Required"] } },
  };
  const sent = fakeArbor(() => Response.json(answer));
  const action = "/guardians/inbound-in-app-message/message-to-school/";
  const school = { value: "99_1_0", label: "Example Primary School" };
  assert.deepEqual(
    await submitForm(SITE, action, { school, subject: "Hello", message: "" }),
    answer,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "POST");
  assert.equal(sent[0]!.url, `${SITE}${action}?format=json`);
  assert.equal(sent[0]!.headers["content-type"], "application/json");
  assert.equal(sent[0]!.headers.authorization, AUTHORIZATION);
  assert.deepEqual(sent[0]!.body, {
    fields: { school: { value: school }, subject: { value: "Hello" }, message: { value: "" } },
  });
});

test("submitForm throws on an HTTP error and never sends again", async () => {
  const sent = fakeArbor(() => new Response("down", { status: 503 }));
  await assert.rejects(submitForm(SITE, "/guardians/x", { a: 1 }), { message: "HTTP 503: down" });
  assert.equal(sent.length, 1);
});

// ------------------------------------------- the page readers

test("findNodes finds every component of a name in page order, attributesOf reads [] as none, textOf makes Arbor's HTML plain", () => {
  const page = node(
    "page",
    [],
    [
      node("section", { title: "A" }, [
        node("property-row", { label: "x" }),
        node("section", { title: "B" }),
      ]),
      node("section", { title: "C" }),
    ],
  );
  assert.deepEqual(
    findNodes(page, "section").map((section: any) => attributesOf(section).title),
    ["A", "B", "C"],
  );
  assert.deepEqual(findNodes(page, "nothing"), []);
  assert.deepEqual(attributesOf(node("page")), {});
  assert.equal(
    textOf("<b>Account balance:</b>\n      &pound;0.00 &amp; Sam&#039;s &#x2014; <br/>ok"),
    "Account balance: £0.00 & Sam's — ok",
  );
  assert.equal(textOf(null), "");
});

test("fieldValues flattens a data endpoint's item", () => {
  assert.deepEqual(
    fieldValues({
      fields: { title: { value: "Swimming" }, location: { value: null }, colour: {} as any },
    }),
    { title: "Swimming", location: null, colour: null },
  );
  assert.deepEqual(fieldValues({}), {});
});

test("readForm gives the form actions and each field with its action, options and the value the app would send", () => {
  const { actions, fields } = readForm(MEAL_FORM as any);
  assert.deepEqual(actions, [
    {
      name: "process-meal-provisions",
      url: "/guardians/basket/process-meal-provisions/meal-rotation-menu-id/9/start-date/2030-01-07/end-date/2030-01-11",
    },
    { name: "delete-meal-provisions", url: "/guardians/basket-item/delete-meal-provisions/" },
  ]);
  assert.deepEqual(
    fields.map(({ field, action, type, value }: any) => ({ field, action, type, value })),
    [
      {
        field: "student",
        action: "process-meal-provisions",
        type: "form-field-hidden",
        value: { value: "1_42_0", label: "Sam Example", group: "Student" },
      },
      {
        field: "basketItems",
        action: "delete-meal-provisions",
        type: "form-field-hidden",
        value: [],
      },
      {
        field: "meal_provision_1893974400",
        action: "process-meal-provisions",
        type: "form-field-combobox",
        value: "7_1",
      },
      {
        field: "meal_provision_1894060800",
        action: "process-meal-provisions",
        type: "form-field-combobox",
        value: null,
      },
    ],
  );
  assert.deepEqual(fields[2]!.options, [
    { value: "7_1", label: "Pasta Bake - £2.50", selected: true },
    { value: "7_2", label: "Jacket Potato - £2.50", selected: false },
    { value: "", label: "No choice selected", selected: false },
  ]);
  assert.equal(fields[2]!.label, "Mon, 07 Jan 2030");
  const message = readForm(
    node(
      "slide-over",
      [],
      [
        node("form-field-textarea", {
          targetField: "message",
          formActionName: "m",
          required: "true",
        }),
      ],
    ) as any,
  );
  assert.deepEqual(message.fields[0], {
    field: "message",
    action: "m",
    type: "form-field-textarea",
    label: null,
    required: true,
    value: null,
  });
});

// ------------------------------------------- the basket and meal booking

const BASKET_URL = `${SITE}/guardians/my-mis-ui/my-basket`;
const CHECKOUT_ACTION = "/guardians/basket/checkout/payment-method/free";
const CHECKOUT_URL = `${SITE}${CHECKOUT_ACTION}?format=json`;
const WEEK_FORM =
  "/guardians/meal-ui/setup-meal-choice/meal-rotation-menu-id/9/student-id/42/date/2030-01-07";
const REVIEWED = { site: SITE, expectedTotal: { amount: 5, currency: "GBP" } };

/** A basket page with two meal rows at £2.50, a total of £5.00, and a checkout button: a plain form
 *  action (`form-action`) unless `role` says otherwise. `change` alters the page before it is sent. */
function basketPage(
  options: { role?: string; total?: string; amount?: string; change?: (page: any) => void } = {},
) {
  const row = (label: string, date: string) =>
    node("property-row", { label, value: "£2.50" }, [
      node("property-row-content", [], [], `<b>Date:</b> ${date}`),
    ]);
  const page = node(
    "page",
    [],
    [
      node(
        "column",
        [],
        [
          node("column-title", [], [], `My Basket: ${options.total ?? "£5.00"}`),
          node("section", { title: "Meals" }, [
            row("Lunch: Pasta Bake (Sam Example)", "07 Jan 2030"),
            row("Lunch: Fish Pie (Sam Example)", "08 Jan 2030"),
          ]),
          node("form-action", { name: "checkout", url: CHECKOUT_ACTION }),
          node("form-field-hidden", {
            targetField: "amount",
            formActionName: "checkout",
            value: options.amount ?? "GBP 5.00",
          }),
          node("form-field-hidden", {
            targetField: "client",
            formActionName: "checkout",
            value: "parent_app",
          }),
          node(
            "action-panel",
            [],
            [
              node("button", {
                formActionName: "checkout",
                label: "Checkout",
                role: options.role ?? "form-action",
              }),
            ],
          ),
        ],
      ),
    ],
  );
  options.change?.(page);
  return page;
}

/** Arbor with a basket, a week's meal form, and answers for the form actions. `checkout` answers the
 *  checkout POST. */
function bookingArbor(
  options: Parameters<typeof basketPage>[0] & {
    checkout?: () => Response | Promise<Response>;
    form?: any;
  } = {},
) {
  const sent = fakeArbor((url) => {
    if (url === BASKET_URL) return Response.json(basketPage(options));
    if (url === `${SITE}${WEEK_FORM}`) return Response.json(options.form ?? MEAL_FORM);
    if (url === CHECKOUT_URL)
      return options.checkout
        ? options.checkout()
        : Response.json({
            success: true,
            action_params: { loadPage: "/guardians/my-mis-ui/my-basket" },
          });
    if (url.endsWith("?format=json")) return Response.json({ success: true, action_params: [] });
  });
  return { sent, checkouts: () => sent.filter((request) => request.url === CHECKOUT_URL) };
}

test("moneyOf reads Arbor's amounts and never a date", () => {
  assert.deepEqual(moneyOf("£2.50"), { amount: 2.5, currency: "GBP" });
  assert.deepEqual(moneyOf("GBP 1,234.50"), { amount: 1234.5, currency: "GBP" });
  assert.deepEqual(moneyOf("<b>Amount: </b>&pound;8.00"), { amount: 8, currency: "GBP" });
  assert.deepEqual(moneyOf("12.5"), { amount: 12.5, currency: "GBP" });
  assert.deepEqual(moneyOf(3), { amount: 3, currency: "GBP" });
  for (const text of ["Week beginning 07 Jan 2030", "", null, undefined, "free"])
    assert.equal(moneyOf(text), null, String(text));
});

test("readBasket reads the total, the rows and the checkout route, and an empty basket", async () => {
  const sent = bookingArbor();
  const basket = await readBasket(SITE);
  assert.deepEqual(basket.total, { amount: 5, currency: "GBP" });
  assert.equal(basket.empty, false);
  assert.deepEqual(basket.items, [
    {
      label: "Lunch: Pasta Bake (Sam Example)",
      lines: ["Date: 07 Jan 2030"],
      amount: { amount: 2.5, currency: "GBP" },
    },
    {
      label: "Lunch: Fish Pie (Sam Example)",
      lines: ["Date: 08 Jan 2030"],
      amount: { amount: 2.5, currency: "GBP" },
    },
  ]);
  assert.equal(basket.checkout!.route, "form");
  assert.deepEqual(basket.checkout!.action, { name: "checkout", url: CHECKOUT_ACTION });
  assert.deepEqual(basket.checkout!.amount, { amount: 5, currency: "GBP" });
  assert.deepEqual(
    basket.checkout!.fields.map((field: any) => field.field),
    ["amount", "client"],
  );
  assert.equal(sent.sent.length, 1);
  assert.equal(sent.sent[0]!.method, "GET");

  bookingArbor({ role: "sca-credit-card-action" });
  assert.equal((await readBasket(SITE)).checkout!.route, "card");

  const empty = node(
    "page",
    [],
    [
      node(
        "column",
        [],
        [
          node("column-title", [], [], "My Basket: £0.00"),
          node("banner", { type: "info", title: "There are no items in your basket" }),
        ],
      ),
    ],
  );
  fakeArbor(() => Response.json(empty));
  const nothing = await readBasket(SITE);
  assert.deepEqual(
    {
      total: nothing.total,
      empty: nothing.empty,
      items: nothing.items,
      checkout: nothing.checkout,
    },
    { total: { amount: 0, currency: "GBP" }, empty: true, items: [], checkout: null },
  );
});

test("chooseMeals reads the week's form again, then sends its process action once with every field and the chosen days changed", async () => {
  const { sent } = bookingArbor();
  await chooseMeals(SITE, WEEK_FORM, { meal_provision_1894060800: "7_1" });
  assert.deepEqual(
    sent.map((request) => [request.method, request.url]),
    [
      ["GET", `${SITE}${WEEK_FORM}`],
      [
        "POST",
        `${SITE}/guardians/basket/process-meal-provisions/meal-rotation-menu-id/9/start-date/2030-01-07/end-date/2030-01-11?format=json`,
      ],
    ],
  );
  assert.deepEqual(sent[1]!.body, {
    fields: {
      student: { value: { value: "1_42_0", label: "Sam Example", group: "Student" } },
      meal_provision_1893974400: { value: "7_1" },
      meal_provision_1894060800: { value: "7_1" },
    },
  });
});

test("chooseMeals refuses a day or an option the form does not have, and no choices, before it sends anything", async () => {
  for (const [choices, message] of [
    [{}, "No meal choices given"],
    [{ meal_provision_1: "7_1" }, "The meal form has no day meal_provision_1"],
    [{ student: "7_1" }, "The meal form has no day student"],
    [
      { meal_provision_1894060800: "7_2" },
      "The meal form has no option 7_2 for meal_provision_1894060800",
    ],
  ] as const) {
    const { sent } = bookingArbor();
    await assert.rejects(chooseMeals(SITE, WEEK_FORM, choices), { message });
    assert.ok(sent.every((request) => request.method === "GET"));
  }
  const { sent } = bookingArbor({ form: node("page") });
  await assert.rejects(chooseMeals(SITE, WEEK_FORM, { a: "b" }), {
    message: "This page has no meal choice form (process-meal-provisions)",
  });
  assert.ok(sent.every((request) => request.method === "GET"));
});

test("removeMealChoices sends the week's delete action once with the basket items it names, and refuses when it names none", async () => {
  const withItems = structuredClone(MEAL_FORM);
  findNodes(withItems as any, "form-field-hidden")[1]!.attributes = {
    targetField: "basketItems",
    formActionName: "delete-meal-provisions",
    value: [{ _objectTypeId: 77, _objectId: 501 }],
  };
  const { sent } = bookingArbor({ form: withItems });
  await removeMealChoices(SITE, WEEK_FORM);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.url, `${SITE}/guardians/basket-item/delete-meal-provisions/?format=json`);
  assert.deepEqual(sent[1]!.body, {
    fields: { basketItems: { value: [{ _objectTypeId: 77, _objectId: 501 }] } },
  });
  const none = bookingArbor();
  await assert.rejects(removeMealChoices(SITE, WEEK_FORM), {
    message: "This week has no meal choices in the basket",
  });
  assert.equal(none.sent.length, 1);
});

test("checkoutBasket reads the basket again, then posts the checkout form once, with redirect manual and a timeout, and returns Arbor's answer", async () => {
  const { sent, checkouts } = bookingArbor();
  assert.deepEqual(await checkoutBasket({ ...REVIEWED, expectedItems: 2 }), {
    success: true,
    action_params: { loadPage: "/guardians/my-mis-ui/my-basket" },
  });
  assert.deepEqual(
    sent.map((request) => [request.method, request.url]),
    [
      ["GET", BASKET_URL],
      ["POST", CHECKOUT_URL],
    ],
  );
  const [checkout] = checkouts();
  assert.deepEqual(checkout!.body, {
    fields: { amount: { value: "GBP 5.00" }, client: { value: "parent_app" } },
  });
  assert.equal(checkout!.headers.authorization, AUTHORIZATION);
  assert.equal(checkout!.headers["arbor-client"], "Mobile");
  assert.equal(checkout!.headers["content-type"], "application/json");
  assert.equal(checkout!.init.redirect, "manual");
  assert.ok(checkout!.init.signal instanceof AbortSignal);
});

test("checkoutBasket refuses bad arguments before any request", async () => {
  const { sent } = bookingArbor();
  for (const bad of [
    { site: "not a url", expectedTotal: { amount: 5, currency: "GBP" } },
    {
      site: "http://example-primary.uk.arbor.education",
      expectedTotal: { amount: 5, currency: "GBP" },
    },
    { site: SITE, expectedTotal: { amount: -1, currency: "GBP" } },
    { site: SITE, expectedTotal: { amount: Number.NaN, currency: "GBP" } },
    { site: SITE, expectedTotal: { amount: 5, currency: "" } },
    { site: SITE },
    { ...REVIEWED, expectedItems: 0 },
    { ...REVIEWED, expectedItems: 1.5 },
  ])
    await assert.rejects(checkoutBasket(bad as typeof REVIEWED), {
      message:
        "The school's site and the reviewed expected total/currency (and item count, if given) are required",
    });
  assert.equal(sent.length, 0);
});

test("checkoutBasket refuses when the total is not the one the person agreed to, and posts nothing", async () => {
  for (const expectedTotal of [
    { amount: 4.99, currency: "GBP" },
    { amount: 5, currency: "EUR" },
  ]) {
    const { checkouts } = bookingArbor();
    await assert.rejects(checkoutBasket({ site: SITE, expectedTotal }), {
      message: "The basket's total has changed; review the basket again",
    });
    assert.equal(checkouts().length, 0);
  }
  const { checkouts } = bookingArbor({ total: "£5.0000001" });
  assert.equal((await checkoutBasket(REVIEWED)).success, true); // pence, not floating point
  assert.equal(checkouts().length, 1);
});

test("checkoutBasket refuses a card payment with a clear reason, and posts nothing", async () => {
  const { sent } = bookingArbor({ role: "sca-credit-card-action" });
  await assert.rejects(checkoutBasket(REVIEWED), {
    message:
      "Checkout blocked: This basket is paid by card (Stripe's payment sheet, Google Pay or a card form with 3-D Secure), which only a person can do in the Arbor app or on the Arbor website",
  });
  assert.deepEqual(
    sent.map((request) => request.method),
    ["GET"],
  );
});

test("checkoutBasket names every other blocker, and posts nothing", async () => {
  const drop = (name: string) => (page: any) => {
    const column = page.children[0];
    column.children = column.children.filter((child: any) => child.name !== name);
  };
  const cases: [Parameters<typeof bookingArbor>[0], string, number?][] = [
    [
      {
        change: (page) => {
          const column = page.children[0];
          column.children = column.children.filter((child: any) => child.name !== "section");
          column.children.push(node("banner", { title: "There are no items in your basket" }));
        },
      },
      "The basket is empty",
    ],
    [{}, "The basket has 2 rows, not the 3 the person reviewed", 3],
    [{ total: "unknown" }, "The basket's total is unavailable"],
    [{ change: drop("action-panel") }, "The basket has no checkout button"],
    [
      {
        role: "sca-credit-card-action",
        change: drop("form-action"),
      },
      "This basket is paid by card (Stripe's payment sheet, Google Pay or a card form with 3-D Secure), which only a person can do in the Arbor app or on the Arbor website; The checkout button has no form action",
    ],
    [
      {
        role: "sca-credit-card-action",
        change: (page) => {
          findNodes(page, "form-action")[0]!.attributes = {
            name: "checkout",
            url: "/guardians/trip/pay",
          };
        },
      },
      "This basket is paid by card (Stripe's payment sheet, Google Pay or a card form with 3-D Secure), which only a person can do in the Arbor app or on the Arbor website; The checkout action is not a basket checkout: /guardians/trip/pay",
    ],
    [{ amount: "GBP 4.00" }, "The checkout form's amount is not the basket's total"],
    [
      {
        change: (page) =>
          page.children[0].children.push(
            node(
              "form-field-combobox",
              { targetField: "payment_method", formActionName: "checkout", label: "Pay with" },
              [
                node(
                  "form-field-combobox-option",
                  { selected: "", value: "credit" },
                  [],
                  "Account credit",
                ),
              ],
            ),
          ),
      },
      "The checkout form's Pay with has no value",
    ],
  ];
  for (const [change, blocker, expectedItems] of cases) {
    const { checkouts } = bookingArbor(change);
    await assert.rejects(
      checkoutBasket({ ...REVIEWED, ...(expectedItems ? { expectedItems } : {}) }),
      { message: `Checkout blocked: ${blocker}` },
    );
    assert.equal(checkouts().length, 0);
  }
});

test("an unclear answer to the checkout POST is CheckoutOutcomeUnknownError, and the POST is never sent again", async () => {
  const unclear: (() => Response | Promise<Response>)[] = [
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    () => new Response("", { status: 500 }),
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 408 }),
    () => new Response("<html>", { status: 200 }),
    () => Response.json({ action_params: [] }),
    () => Response.json([]),
  ];
  for (const checkout of unclear) {
    const { checkouts } = bookingArbor({ checkout });
    const error = await checkoutBasket(REVIEWED).catch((error: unknown) => error);
    assert.ok(error instanceof CheckoutOutcomeUnknownError);
    assert.deepEqual(error.expectedTotal, { amount: 5, currency: "GBP" });
    assert.equal(
      error.message,
      "The basket checkout outcome is unknown. Read the basket (readBasket), the invoices and the meal choices before anything else; the basket may have been checked out.",
    );
    assert.equal(checkouts().length, 1);
  }
});

test("a refusal of the checkout POST says so, and is not an unknown outcome", async () => {
  for (const [checkout, message] of [
    [
      () => new Response("", { status: 409 }),
      "Arbor rejected the checkout (HTTP 409). Read the basket before trying again.",
    ],
    [
      () =>
        Response.json({
          success: false,
          action_params: {
            validation_errors: { __form__: ["<b>Deadline</b> passed"], amount: ["Too low"] },
          },
        }),
      "Arbor rejected the checkout: Deadline passed; Too low. Read the basket before trying again.",
    ],
    [
      () => Response.json({ success: false }),
      "Arbor rejected the checkout. Read the basket before trying again.",
    ],
  ] as const) {
    const { checkouts } = bookingArbor({ checkout });
    const error = await checkoutBasket(REVIEWED).catch((error: unknown) => error);
    assert.ok(error instanceof Error && !(error instanceof CheckoutOutcomeUnknownError));
    assert.equal(error.message, message);
    assert.equal(checkouts().length, 1);
  }
});

// ------------------------------------------- the login, as the secret's refresh

const SCHOOLS = [
  { applicationId: "ex_abc_123456", baseUrl: SITE, name: "Example Primary School", type: "school" },
  {
    applicationId: "ex_def_654321",
    baseUrl: "https://example-high.uk.arbor.education/",
    type: "school",
  },
];
const MATERIAL = { username: "parent@example.com", password: "hunter2", site: SITE };
const TOKENS = (access: string, refresh: string) => ({
  access_token: access,
  expires_in: 3600,
  token_type: "bearer",
  scope: "GUARDIAN",
  refresh_token: refresh,
  schools: SCHOOLS,
});

/** Arbor's central login for the exchange: `grants` answers each body it is sent. */
function loginWith(grants: (body: any) => Response) {
  const seen: { url: string; init: RequestInit; body: any }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const body = JSON.parse(init.body as string);
    seen.push({ url, init, body });
    return grants(body);
  };
  return { seen, fetch };
}

test("exchange logs in with the password grant of the app's client, without any Authorization header, and keeps the material with both tokens", async () => {
  const { seen, fetch } = loginWith(() => Response.json(TOKENS("jwt-1", "r-1")));
  assert.deepEqual(await exchange(MATERIAL, fetch), {
    ...MATERIAL,
    accessToken: "jwt-1",
    refreshToken: "r-1",
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://login.arbor.sc/oauth2/token");
  assert.equal(seen[0]!.init.method, "POST");
  const headers = Object.fromEntries(
    Object.entries(seen[0]!.init.headers as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(seen[0]!.body, {
    grant_type: "password",
    username: "parent@example.com",
    password: "hunter2",
    client_id: "ARBOR_PARENT_APP",
    scope: "GUARDIAN",
  });
});

test("exchange uses the refresh token first, and the password when Arbor refuses it", async () => {
  let { seen, fetch } = loginWith(() => Response.json(TOKENS("jwt-2", "r-2")));
  assert.deepEqual(
    await exchange({ ...MATERIAL, accessToken: "old", refreshToken: "r-1" }, fetch),
    {
      ...MATERIAL,
      accessToken: "jwt-2",
      refreshToken: "r-2",
    },
  );
  assert.deepEqual(
    seen.map((s) => s.body),
    [{ grant_type: "refresh_token", refresh_token: "r-1", client_id: "ARBOR_PARENT_APP" }],
  );
  ({ seen, fetch } = loginWith((body) =>
    body.grant_type === "refresh_token"
      ? Response.json(
          { error: "invalid_grant", error_description: "Invalid refresh token" },
          { status: 400 },
        )
      : Response.json(TOKENS("jwt-3", "r-3")),
  ));
  const result = await exchange({ ...MATERIAL, refreshToken: "r-gone" }, fetch);
  assert.equal(result.accessToken, "jwt-3");
  assert.equal(result.refreshToken, "r-3");
  assert.deepEqual(
    seen.map((s) => s.body.grant_type),
    ["refresh_token", "password"],
  );
});

test("exchange accepts the site with any case and trailing slash, and refuses a missing or wrong one, naming the account's schools", async () => {
  const { fetch } = loginWith(() => Response.json(TOKENS("jwt-1", "r-1")));
  assert.equal(
    (await exchange({ ...MATERIAL, site: "https://EXAMPLE-HIGH.uk.arbor.education" }, fetch))
      .accessToken,
    "jwt-1",
  );
  assert.equal((await exchange({ ...MATERIAL, site: `${SITE}/` }, fetch)).accessToken, "jwt-1");
  const schools = `${SITE}, https://example-high.uk.arbor.education`;
  await assert.rejects(
    exchange({ ...MATERIAL, site: "https://elsewhere.uk.arbor.education" }, fetch),
    {
      message: `arbor: the secret's site https://elsewhere.uk.arbor.education is not one of this account's schools: ${schools}`,
    },
  );
  await assert.rejects(exchange({ username: "parent@example.com", password: "hunter2" }, fetch), {
    message: `arbor: the secret has no "site", which must be one of this account's schools: ${schools}`,
  });
});

test("exchange refusals name the fix and never the credential", async () => {
  const answering = (response: () => Response) => async () => response();
  const attempts = [
    [
      exchange(
        MATERIAL,
        answering(() => Response.json({ error: "invalid_grant" }, { status: 400 })),
      ),
      /HTTP 400, invalid_grant\): check the secret's username and password/,
    ],
    [
      exchange(
        MATERIAL,
        answering(() => new Response("", { status: 503 })),
      ),
      /HTTP 503\)/,
    ],
    [
      exchange(
        MATERIAL,
        answering(() => Response.json({})),
      ),
      /no access_token/,
    ],
    [
      exchange(
        { username: "parent@example.com" },
        answering(() => Response.json({})),
      ),
      /no "username" and "password"/,
    ],
  ] as const;
  for (const [attempt, expected] of attempts) {
    const error = (await attempt.catch((caught: Error) => caught)) as Error;
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /hunter2|parent@example/);
  }
});

test("EXCHANGE_SOURCE is a module exporting the same exchange", async () => {
  const shipped = await import(`data:text/javascript,${encodeURIComponent(EXCHANGE_SOURCE)}`);
  const result = await shipped.exchange(MATERIAL, async () =>
    Response.json(TOKENS("jwt-4", "r-4")),
  );
  assert.deepEqual(result, { ...MATERIAL, accessToken: "jwt-4", refreshToken: "r-4" });
});

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("the README's exchange block is the shipped EXCHANGE_SOURCE", () => {
  assert.ok(README.includes(EXCHANGE_SOURCE), "README is out of date: paste EXCHANGE_SOURCE");
});

test("the README's script calls Arbor as the package does: the same request as arborGet", async () => {
  const script = README.split("### The helpers in a script")[1]?.match(/```js\n([\s\S]*?)```/)?.[1];
  assert.ok(script, "README has no script under 'The helpers in a script'");
  const run = (
    await import(`data:text/javascript,${encodeURIComponent(`export default ${script}`)}`)
  ).default;
  const settings = { userId: 7, display_name: "Pat Example", logged_in: true };
  const sent = fakeArbor((url) =>
    url.endsWith("/auth/current-user-settings")
      ? Response.json({ items: [settings], success: true, action_params: [], notifications: [] })
      : undefined,
  );
  const itx = {
    secrets: { list: async () => [{ path: "/secrets/arbor", public: { site: SITE } }] },
  };
  assert.deepEqual(await run(itx), settings);
  await arborGet(SITE, "/auth/current-user-settings");
  const [fromScript, fromPackage] = sent.map(({ url, method, headers }) => ({
    url,
    method,
    headers,
  }));
  assert.deepEqual(fromScript, fromPackage);
});

// ------------------------------------------- the card on the Dash

/** A project with `secrets` (path to its public fields) and an /integrations context that keeps
 *  what is appended, as the platform does with an idempotency key. */
function project(secrets: Record<string, Record<string, unknown> | undefined>) {
  const appended: { path: string; event: any }[] = [];
  const itx: any = {
    secrets: {
      list: async () => Object.entries(secrets).map(([path, fields]) => ({ path, public: fields })),
    },
    cd: (path: string) => ({
      append: async (event: any) => {
        const earlier = appended.find((a) => a.event.idempotencyKey === event.idempotencyKey);
        if (earlier && JSON.stringify(earlier.event) === JSON.stringify(event)) return;
        if (earlier) throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
  };
  return { itx, appended };
}

const card = (status: object) => ({
  title: "Arbor",
  description:
    "Arbor, the school's MIS, as a parent sees it (children, meals, messages, calendar, attendance, payments, clubs and trips): agents and the project's code call it with fetch and the token's placeholder.",
  icon: "https://www.google.com/s2/favicons?domain=arbor-education.com&sz=64",
  status,
  actions: [
    { label: "Open", routingSlug: "arbor", path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

test("arbor() answers the arbor routing slug; its install hook registers the card, keyed by the event's path and offset, ok once the account's secret has its site", async () => {
  const secrets: Record<string, Record<string, unknown> | undefined> = {};
  const { itx, appended } = project(secrets);
  const integration = arbor();
  assert.equal(integration.routingSlug, "arbor");
  const publish = (
    offset: number,
    type = "events.iterate.com/project/worker-updated",
    payload?: object,
  ) => integration.processEvent!({ event: { type, path: "/", offset, payload }, itx });

  for (let attempt = 0; attempt < 2; attempt++) await publish(5);
  secrets["/secrets/arbor"] = {};
  await publish(5); // the same event again, now with the secret: its key is spent, and that is fine
  await publish(6);
  secrets["/secrets/arbor"] = { site: SITE };
  await publish(7, "events.iterate.com/secret/set", { path: "/secrets/arbor" });
  await integration.processEvent!({
    event: {
      type: "events.iterate.com/secret/set",
      path: "/secrets/arbor",
      offset: 1,
      payload: { path: "/secrets/arbor" },
    },
    itx,
  }); // the copy on the secret's own path comes before the catalog has it: passed over
  await publish(8, "events.iterate.com/secret/set", { path: "/secrets/other" });
  await publish(9, "events.iterate.com/itx/woken");
  assert.deepEqual(
    appended.map(({ path, event }) => ({
      path,
      key: event.idempotencyKey,
      card: event.payload.card,
    })),
    [
      {
        path: "/integrations",
        key: "arbor:registry:/@5",
        card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
      },
      {
        path: "/integrations",
        key: "arbor:registry:/@6",
        card: card({ kind: "attention", text: "The account has no school site: see the recipe" }),
      },
      {
        path: "/integrations",
        key: "arbor:registry:/@7",
        card: card({ kind: "ok", text: "example-primary.uk.arbor.education" }),
      },
    ],
  );
  assert.ok(
    appended.every(({ event }) => event.type === "events.iterate.com/integration/configured"),
  );
});

test("a site that is no URL still registers the card", async () => {
  const { itx, appended } = project({ "/secrets/arbor": { site: "example primary" } });
  await arbor().processEvent!({
    event: { type: "events.iterate.com/project/worker-updated", path: "/", offset: 1 },
    itx,
  });
  assert.deepEqual(appended[0]!.event.payload.card.status, { kind: "ok", text: "example primary" });
});

// ------------------------------------------- the page

/** The worker hosting the package, over a project with `secrets`: a scope per `getItx`, counted,
 *  and a member gate that refuses unless `member` is set. */
function hosted(
  secrets: Record<string, Record<string, unknown> | undefined>,
  options: { member?: boolean } = {},
) {
  const scopes = { opened: 0, disposed: 0 };
  const integration = arbor();
  const serve = (request: Request) =>
    integration.fetch!(request, {
      getItx: () => {
        scopes.opened++;
        return { ...project(secrets).itx, [Symbol.dispose]: () => void scopes.disposed++ };
      },
      auth: {
        require: () => (options.member ? null : new Response("Sign in\n", { status: 401 })),
      },
    });
  const page = (path: string) => serve(new Request(`${ORIGIN}${path}`));
  return { scopes, serve, page };
}

test("the page is for members: a non-member gets what auth.require answers, and nothing is read", async () => {
  const site = hosted({ "/secrets/arbor": { site: SITE } });
  for (const path of ["/", "/nope"]) {
    const res = await site.page(path);
    assert.equal(res.status, 401, path);
    assert.equal(await res.text(), "Sign in\n");
  }
  assert.deepEqual(site.scopes, { opened: 0, disposed: 0 });
});

test("the page shows the status: what to paste into a coding agent until the account has its site, then the site", async () => {
  const sent = fakeArbor(() => undefined);
  const hint = `Set up Arbor in my iterate project. Follow the recipe at ${RECIPE}`;
  let html = await (await hosted({}, { member: true }).page("/")).text();
  assert.match(html, /<h1>Arbor<\/h1>/);
  assert.match(html, /Set up by your coding agent: see the recipe/);
  assert.ok(html.includes(`data-copy="${hint}"`));
  assert.ok(html.includes(`href="${RECIPE}"`));

  html = await (await hosted({ "/secrets/arbor": {} }, { member: true }).page("/")).text();
  assert.match(html, /has no school site/);
  assert.ok(html.includes(`data-copy="${hint}"`));

  const site = hosted({ "/secrets/arbor": { site: SITE } }, { member: true });
  const res = await site.page("/");
  html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.ok(
    html.includes(
      `Set up. The project has the Arbor account <code>/secrets/arbor</code>, for the school site <code>${SITE}</code>.`,
    ),
  );
  assert.doesNotMatch(html, /coding agent|data-copy="/);
  assert.deepEqual(site.scopes, { opened: 1, disposed: 1 });
  assert.deepEqual(sent, []); // the page never calls Arbor
});

test("the page sends a CSP with its one nonce'd script, no form, and no frame, and X-Frame-Options DENY", async () => {
  const res = await hosted({}, { member: true }).page("/");
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
  const site = hosted({ "/secrets/arbor": { site: SITE } }, { member: true });
  for (const path of ["/nope", "/webhook", "/oauth2/callback"])
    assert.equal((await site.page(path)).status, 404, path);
  assert.equal((await site.serve(new Request(`${ORIGIN}/`, { method: "POST" }))).status, 404);
  assert.deepEqual(site.scopes, { opened: 0, disposed: 0 });
});

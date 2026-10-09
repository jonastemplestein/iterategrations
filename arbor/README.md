# Arbor

[Arbor](https://arbor-education.com) is the MIS many UK schools use. This package gives an iterate
project the parent's view of it: the children, school meals (menus, choices, balance), messages to
and from the school, the calendar, attendance, payments and balances, clubs and trips, assignments,
behaviour and report cards. It logs in with the parent's own Arbor account. There is no client to
install: a run script, the project's own code and an agent call Arbor with plain `fetch`. Arbor
publishes no API for parents, so [Calling Arbor](#calling-arbor) is the doc. It is unofficial and
not affiliated with Arbor Education.

The project never holds the password or the token: they live in a secret, and iterate's egress
swaps the token into each request and logs in again when Arbor answers 401.

It is the package `iterate-arbor`. `arborFetch` and `arborGet` add what every call needs, and
`readForm` and the other readers take apart Arbor's pages. `submitForm`, `chooseMeals` and
`removeMealChoices` change things at the school, and `checkoutBasket` is the one call that can spend
money, with its guards ([Booking meals](#booking-meals)). The login is the secret's refresh. `arbor()` is one element in the
`integrations` array of the project's config worker, with a page of its own for the project's
members: the status. The project's Integrations page in the Dash shows an Arbor card ("Set up by
your coding agent" until the account's secret exists), with an **Open** button to the page and a
**Recipe** button to this recipe.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 1. The account, as a secret

Each school has its own Arbor site, such as `https://example-primary.uk.arbor.education`. The
account logs in centrally, and the token works on the site of each of the account's schools. The
secret keeps the site as a public field, so the project's code can read it.

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/arbor",
    egress: { urls: ["https://login.arbor.sc"] },
    description:
      "Your Arbor parent account: the email and password you log in to the Arbor app with, and your school's Arbor address. The address is in your browser after you log in to Arbor on the web, such as https://your-school.uk.arbor.education. The email and password are only ever sent to login.arbor.sc.",
    fields: [
      { name: "username", label: "Email" },
      { name: "password", label: "Password" },
      {
        name: "site",
        label: "Your school's Arbor address",
        public: true,
        placeholder: "https://your-school.uk.arbor.education",
        pattern: String.raw`https://[a-z0-9\-]+(\.[a-z0-9\-]+)*\.arbor\.(education|sc)/?`,
      },
    ],
  });
```

Send the person the returned `url` and wait until they say it is saved. Then read the site and
give the secret its two origins and its login. The login is the module below (`EXCHANGE_SOURCE` in
the package; it runs in a jail that can reach the secret's origins and nothing else). Pass its text
as `source`:

```js
async (itx) => {
  const entry = (await itx.secrets.list()).find((secret) => secret.path === "/secrets/arbor");
  const site = new URL(entry?.public?.site ?? "").origin; // throws if the person saved no site
  await itx.secrets.set(
    "/secrets/arbor",
    {},
    {
      urls: ["https://login.arbor.sc", site],
      public: ["site"],
      merge: true, // keeps the username, password and site the person saved
      refresh: { kind: "worker", source: `<the module below, as a string>` },
    },
  );
  return site;
};
```

<!-- prettier-ignore -->
```js
export async function exchange(material, fetch) {
	const tokenUrl = "https://login.arbor.sc/oauth2/token";
	const clientId = "ARBOR_PARENT_APP";
	const { username, password, site, refreshToken } = material;
	if (typeof username !== "string" || !username || typeof password !== "string" || !password) throw new Error("arbor: the secret's material has no \"username\" and \"password\"");
	const post = (body) => fetch(tokenUrl, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"user-agent": "okhttp/4.12.0"
		},
		body: JSON.stringify(body)
	});
	const refreshed = typeof refreshToken === "string" && refreshToken ? await post({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId
	}) : null;
	const renewed = refreshed?.ok ? await refreshed.json().catch(() => null) : null;
	const login = renewed?.access_token ? null : await post({
		grant_type: "password",
		username,
		password,
		client_id: clientId,
		scope: "GUARDIAN"
	});
	const loggedIn = login ? await login.json().catch(() => null) : null;
	if (login && !login.ok) throw new Error(`arbor: login refused (HTTP ${login.status}${typeof loggedIn?.error === "string" ? `, ${loggedIn.error.slice(0, 40)}` : ""}): check the secret's username and password`);
	const answer = login ? loggedIn : renewed;
	if (!answer?.access_token) throw new Error("arbor: login returned no access_token");
	const trim = (url) => url.trim().replace(/\/+$/, "").toLowerCase();
	const sites = (Array.isArray(answer.schools) ? answer.schools : []).map((school) => typeof school?.baseUrl === "string" ? trim(school.baseUrl) : "").filter(Boolean);
	const wanted = typeof site === "string" ? trim(site) : "";
	if (!sites.includes(wanted)) throw new Error(`arbor: ${wanted ? `the secret's site ${wanted} is not` : "the secret has no \"site\", which must be"} one of this account's schools: ${sites.join(", ") || "none"}`);
	return {
		...material,
		accessToken: answer.access_token,
		refreshToken: answer.refresh_token ?? refreshToken
	};
}
```

The login checks the site: when it is not one of the account's schools, the first call answers 502
with a text that names the account's school sites. Then run the script above again with
`const site = "<the right address>";` as its second line and `{ site }` in place of `{}`.

## 2. The package, in the project's config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and the element to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-arbor";
const IMPORT = 'import { arbor } from "iterate-arbor";';
const ELEMENT = "arbor()";
const MEMBER = "";
const FILES = {};
```

`arbor()` answers the project's `arbor` host. Its page at `/` is for the project's members: it shows
the status (whether the account's secret exists, and for which school site). It has no webhook, so
there is no URL to paste. Its install hook (`project/worker-updated`, and the account's secret set
or deleted) puts the Arbor card on the Dash. With the package in `package.json`, the project's code
can import the helpers.

### By hand, or copy the source

By hand: [add-to-a-project.md](../add-to-a-project.md#by-hand), with the import and the element above.
To copy the source instead, read [`src/index.ts`](src/index.ts) (`arbor()` and the exports),
[`src/page.ts`](src/page.ts) (its page), [`src/fetch.ts`](src/fetch.ts) (`arborFetch`, `arborGet`,
`arborUrl` and `submitForm`), [`src/tree.ts`](src/tree.ts) (the readers),
[`src/basket.ts`](src/basket.ts) (the basket and meal booking) and
[`src/exchange.ts`](src/exchange.ts), and commit them to `/repos/config` under `arbor/`. They have no
dependencies. You own the copy. The import then reads `from "./arbor/index.ts"`.

## 3. Prove it

Run the script in [The helpers in a script](#the-helpers-in-a-script) as it is. It reads the user
settings of the logged-in parent. A `userId` and `logged_in: true` back is the proof. The first call
logs in by the secret's refresh, so it takes a moment.

Then write into the project's `AGENTS.md` that agents call Arbor with `fetch` and the token's
placeholder, with a link to this README's
[Calling Arbor](https://github.com/jonastemplestein/iterategrations/tree/main/arbor#calling-arbor).

## Calling Arbor

Read this before the first call. This is the API of Arbor's Android parent app (version 51.0.0),
found in the app and checked against one parent account. Each item below says which: **live** is a
call made to a real school's site with a real parent account (read-only calls only); **linked** is
a path a live page links to, never called; **code** is seen in the app's code and never called. Every call is plain `fetch`. In every worker the platform
loads (the project's config worker, a run script), the global `fetch` is the project's egress, so a
run script, the project's code and an agent all call Arbor the same way.

- **The placeholder:**
  `authorization: 'Bearer getSecret("/secrets/arbor", { field: "accessToken" })'`, on every
  request. Egress swaps in the real token on the way out. It reads headers and the URL, never a
  body.
- **The origins:** `https://login.arbor.sc` (the login) and the school's site, such as
  `https://your-school.uk.arbor.education`: the two the secret is pinned to. Egress sends the token
  nowhere else. The site is the secret's public field `site`:
  `(await itx.secrets.list()).find((secret) => secret.path === "/secrets/arbor").public.site`.
- **Expiry:** do nothing. The token lasts an hour. When Arbor answers 401, the platform logs in
  again by the secret's refresh ([`exchange.ts`](src/exchange.ts), step 1) and sends the request
  again, once. A 401 that still reaches you means that login failed too. When that login fails, the
  answer is a 502 whose text says why.
- **The headers**, as `arborFetch` sends them:
  - `authorization`: the placeholder.
  - `arbor-client: Mobile`. It selects the app's page format. Without it, Arbor answers the web
    front end's format (`{ type: "page", content: [{ componentName: "Arbor.container…" }] }`),
    which this README does not cover.
  - `mobile-app-version: 0.22.0`, `x-pci-compliant: yes` and `user-agent: okhttp/4.12.0`, as the
    app sends them.
  - `accept: application/json`.
  - `content-type: application/json`, when the request has a body.

### The helpers

The project's code imports them:

```ts
import {
  arborFetch,
  arborGet,
  arborUrl,
  attributesOf,
  checkoutBasket,
  chooseMeals,
  fieldValues,
  findNodes,
  moneyOf,
  readBasket,
  readForm,
  removeMealChoices,
  submitForm,
  textOf,
} from "iterate-arbor";
```

- `arborFetch(input, init?)` is `fetch` with those headers merged in. Headers you pass win.
- `arborUrl(site, path)` makes a path as Arbor's pages give it (`/guardians/…`, `guardians/…` or
  `/?/guardians/…`) a URL on the site. A full URL stays as it is.
- `arborGet(site, path)` GETs the path through `arborFetch` and returns the JSON: a page or a data
  answer ([How Arbor answers](#how-arbor-answers)). It throws on an HTTP error
  (`HTTP <status>: <Arbor's message>`), on `success: false` and on an answer that is not JSON.
- `submitForm(site, action, fields)` **changes something at the school**: [Forms](#forms-every-change).
- `findNodes(page, name)` gives every component of that name, in page order.
  `attributesOf(node)` gives a component's attributes (Arbor sends `[]` for none). `textOf(html)`
  makes Arbor's HTML text plain. `fieldValues(item)` flattens one item of a data answer.
  `readForm(page)` gives a page's form actions and its fields, with their options and the value the
  app would send. `moneyOf(text)` reads an amount (`£2.50`, `GBP 2.50`) as `{ amount, currency }`.
- `readBasket(site)`, `chooseMeals(site, formUrl, choices)`, `removeMealChoices(site, formUrl)` and
  `checkoutBasket({ site, expectedTotal })`: [Booking meals](#booking-meals).

```js
const site = "https://your-school.uk.arbor.education"; // the secret's public site
const page = await arborGet(site, "/guardians/home-ui/dashboard");
for (const section of findNodes(page, "section")) console.log(attributesOf(section).title);
```

### The helpers in a script

A run script cannot import a package, so it starts with the helpers as text. As it is, this script
reads the user settings of the logged-in parent: the `userId` (the unread count needs it), the
`display_name` and whether payments are on.

```js
async (itx) => {
  // the school's site: the secret's public field
  const entry = (await itx.secrets.list()).find((secret) => secret.path === "/secrets/arbor");
  const site = entry?.public?.site;
  if (!site) throw new Error("/secrets/arbor has no site: see step 1 of the recipe");
  // arborFetch, arborUrl and arborGet, as the package exports them
  const arborFetch = (input, init = {}) => {
    const headers = new Headers({
      authorization: 'Bearer getSecret("/secrets/arbor", { field: "accessToken" })',
      "arbor-client": "Mobile",
      "mobile-app-version": "0.22.0",
      "x-pci-compliant": "yes",
      accept: "application/json",
      "user-agent": "okhttp/4.12.0",
      ...(init.body ? { "content-type": "application/json" } : {}),
    });
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return fetch(input, { ...init, headers });
  };
  const arborUrl = (path) =>
    /^https?:\/\//i.test(path)
      ? new URL(path)
      : new URL(path.replace(/^\/*(\?\/)?\/*/, ""), site.trim().replace(/\/*$/, "/"));
  const arborGet = async (path) => {
    const response = await arborFetch(arborUrl(path));
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    const answer = JSON.parse(text);
    if (answer?.success === false) throw new Error(`Arbor refused: ${text.slice(0, 300)}`);
    return answer;
  };
  // the readers, as the package exports them (readForm is in src/tree.ts)
  const attributesOf = (node) =>
    node?.attributes && !Array.isArray(node.attributes) ? node.attributes : {};
  const findNodes = (root, name) => {
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.name === name) found.push(node);
      for (const child of node.children ?? []) walk(child);
    };
    walk(root);
    return found;
  };
  const textOf = (html) =>
    (html ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&pound;/g, "£")
      .replace(/&amp;/g, "&")
      .replace(/&#0?39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  const fieldValues = (item) =>
    Object.fromEntries(
      Object.entries(item.fields ?? {}).map(([name, field]) => [name, field?.value ?? null]),
    );
  const {
    items: [settings],
  } = await arborGet("/auth/current-user-settings");

  // The task: the user settings
  return settings;
};
```

Each example below is a task: keep everything above `// The task`, and put the example in place of
the rest. The project's code writes the same lines, with the helpers imported and `site` as their
first argument.

### How Arbor answers

The app draws Arbor's own pages. A page is a tree of components, each
`{ name, attributes, children, content }`:

- `name` is the component, such as `page`, `slide-over` (a page that opens over another), `column`,
  `column-title`, `section` (with a `title`), `property-row` (a `label` and a `value` or
  `description`), `property-row-content` (one line of text), `event-listener` (a link: its
  `action` is `load-page`, with a `url`), `button` (a `label`, a `role` and a `url` or a
  `formActionName`), `info-panel`, `page-toggle` and its `page-toggle-item`s (`label`, `url`, `selected: "1"`),
  `sub-nav-column` and its `sub-nav-item`s (the menu), `banner`, `simple-text`, `kpi-panel` and
  `new-kpi-panel` (a `url` to its KPIs), `widget-calendar`, and the form components
  ([Forms](#forms-every-change)).
- `attributes` are its settings. Arbor sends `[]` when there are none.
- `content` is its text, often HTML (`<b>Status:</b> Paid`): `textOf` makes it plain.
- Every `url` is a path on the school's site: `arborGet(site, url)` loads it.

Arbor sends a page with `content-type: text/html`, but the body is this JSON.

A data answer is `{ items, success, action_params, notifications }`. An item is usually
`{ fields: { <name>: { value } } }` (`fieldValues` flattens it). `action_params` holds more about
the answer, such as the next day's URL. A KPI panel's URL answers a list of KPIs instead (see
[KPIs](#kpis)).

An error is an HTTP status with JSON. A page that is not there answers 404 with
`{ success: false, message, sentryId, isNotFoundException }` (`message` is HTML). A path with a
wrong ID answered the same. A token that is not valid answers 401 with
`{ code: "API-AUTHENTICATION-REQUIRED", message: "Authentication required." }`.

The IDs in the paths below (`<studentId>`, `<customerAccountId>`, …) come from the pages
themselves: follow the URLs a page gives rather than build them. The paths are as the pages gave
them on 9 October 2026; Arbor can change them.

### The parent and the children

- `GET /auth/current-user-settings` (live): `{ items: [settings] }`. `settings` has `logged_in`,
  `userId`, `display_name`, `language`, `user_type: "guardian"`, `organizationName` (the school),
  `applicationId`, `calendarUrl`, `notifications { unreadCount, pushChannel }`,
  `payment { enabledPayment, enableMobilePay, stripePublishableKey, isTestPaymentEnv }`,
  `availableLanguages` and a `jwt` (a second token, for `/api/me/language`). The app checks
  `logged_in === true` after login.
- `GET /guardians/home-ui/dashboard` (live): the landing page, for one child. Its `sub-nav-column`
  is that child's menu: Main Dashboard, Profile, Calendar, Attendance (Summary, By Date), Activities
  (Trips, Clubs), Behaviour, Report Cards, Assignments (Overview, Due, Overdue, Submitted), Payments
  (Active Payments, Invoices, Top-Ups, Credit Notes), School Shop, Basket and Guardian
  Consultations, each with its `url`. Its `widget-zone-column` has a `menu-button` of quick actions
  (Meals is here, `/guardians/meal-ui/meal-choices/student-id/<studentId>`), an `info-panel` (the
  child's name in `info-panel-title`, the form in an `info-panel-property`, a `picture` URL), a
  button to the messages, the notices `section`, a payments `new-kpi-panel` and a
  `widget-calendar`. A `column` has a `kpi-panel` (attendance), consultations, the child's
  accounts with their balances (`Balance: £0.00`), activities and the school shop.
- The children (code): with more than one child, the dashboard's `widget-zone-column` has a
  `page-toggle` whose `page-toggle-item`s are the children: `label` (the name, which the app shows
  without `[` and `]`), `url` (that child's dashboard) and `selected`. With one child there is no
  toggle (live): the child is the `info-panel`, and its `<studentId>` is in every URL.
- `GET /guardians/home-ui/dashboard/student-id/<studentId>` (linked): one child's dashboard.
- `GET /guardians/student-ui/overview/id/<studentId>` (live): the profile: student details
  (name, sex, date of birth, ethnicity, religion, languages), contact details, family, guardians
  and contacts, mode of travel, meal preferences and dietary requirements, previous schools,
  medical. Most rows link to an edit form.
- `GET /guardians/my-mis-ui/my-account?format=javascript` (live): the parent's username, and a link
  to `/guardians/my-mis-ui/change-password/`.

```js
// The task: the children, with their student IDs
const dashboard = await arborGet("/guardians/home-ui/dashboard");
const zone = findNodes(dashboard, "widget-zone-column")[0];
const toggle = zone && findNodes(zone, "page-toggle")[0];
const idOf = (url) => /(?:student-id|\/id)\/(\d+)/.exec(url ?? "")?.[1] ?? null;
if (toggle)
  return toggle.children.map((item) => {
    const { label, url } = attributesOf(item);
    return { name: textOf(label).replace(/^\[|\]$/g, ""), studentId: idOf(url) };
  });
const panel = findNodes(dashboard, "info-panel")[0];
return [
  {
    name: textOf(findNodes(panel, "info-panel-title")[0]?.content),
    studentId: idOf(attributesOf(panel).url),
  },
];
```

### Meals

- `GET /guardians/meal-ui/meal-choices/student-id/<studentId>` (live): the meal menus open to the
  child. A `page-toggle` picks the academic year (`…/academic-year-id/<academicYearId>`). A section
  lists the menus: each `property-row` has the menu's name as `label` (such as "Lunch Menu"), a
  `value` (such as "Meal choices available") and the `url` of its weeks.
- `GET /guardians/meal-ui/setup-meal-choices/meal-rotation-menu-id/<menuId>/student-id/<studentId>`
  (live): the menu's weeks. A `section` per week (`title: "Week beginning 07 Jan 2030"`), with a
  `property-row` per day: `label` the weekday, `value` the meal chosen (or the menu's main meal),
  `description` such as "Deadline passed". A day that is still open has an `event-listener` with the
  `url` of that week's form. The `widget-zone-column` has the meals balance (`new-kpi-panel`) and a
  "Top up account" button.
- `GET /guardians/meal-ui/setup-meal-choice/meal-rotation-menu-id/<menuId>/student-id/<studentId>/date/<YYYY-MM-DD>`
  (live): the form for the week of that date. A `banner` gives the school's deadline for choices.
  A `form-field-combobox` per day: `targetField`
  `meal_provision_<Unix time of that day's midnight, UK time>`, `label` the date, and a
  `form-field-combobox-option` per meal (`value` such as `"12_3"`, `content` "Pasta Bake -
  £0.00", `selected: "1"` for the current choice, and `value: ""` for "No choice selected").
  Hidden fields carry the student and `is_mobile_app: 1`. The form also has a
  `delete-meal-provisions` action (`/guardians/basket-item/delete-meal-provisions/`) whose hidden
  `basketItems` names the week's choices in the basket. To change the choices, see
  [Booking meals](#booking-meals).
- `GET /guardians/customer-account/meals-balance-kpi/student-id/<studentId>` (live): the meals
  balance, as a KPI: `[{ mainValue: "£0.00", url }]`, the `url` being the meals account.
- The meals account: [Payments and balances](#payments-and-balances).

```js
// The task: a menu's weeks, with each day's meal and whether it can still change
const studentId = "<studentId>";
const choices = await arborGet(`/guardians/meal-ui/meal-choices/student-id/${studentId}`);
const menus = findNodes(choices, "property-row")
  .map(attributesOf)
  .filter((menu) => menu.url);
const weeks = await arborGet(menus[0].url);
return findNodes(weeks, "section").map((week) => ({
  week: attributesOf(week).title,
  days: week.children
    .filter((row) => row.name === "property-row")
    .map((row) => ({
      day: attributesOf(row).label,
      meal: attributesOf(row).value,
      note: attributesOf(row).description || null,
      form: attributesOf(findNodes(row, "event-listener")[0]).url ?? null,
    })),
}));
```

### Messages

- `GET /guardians/communication-center-ui/school-messages/` (live): the school's messages to the
  parent, in a `section` titled "School Messages", and a "Send new message" button to the form
  below. The account we read had no messages, so the rows of a message were not seen.
- `POST /guardians/communication-center/number-of-unread-in-app-messages/user-id/<userId>` (live),
  with no body and `content-type: application/x-www-form-urlencoded`, as the app sends it. It only
  reads: `{ items: [{ fields: { badge: { value: 0 } } }] }`, the number of unread messages. The
  user settings' `notifications.unreadCount` has it too.
- `GET /guardians/inbound-in-app-message-ui/message-to-school` (live): the form to write to the
  school ([Writing to the school](#writing-to-the-school)).

```js
// The task: the number of unread messages
const { userId } = (await arborGet("/auth/current-user-settings")).items[0];
const response = await arborFetch(
  arborUrl(`/guardians/communication-center/number-of-unread-in-app-messages/user-id/${userId}`),
  { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
return fieldValues((await response.json()).items[0]).badge;
```

### Calendar

- `GET /guardians/widget-data/get-calendar-data/student-id/<studentId>/` (live): today's events,
  and `GET …/student-id/<studentId>/date/<YYYY-MM-DD>` (live) another day's. Each item's fields:
  `start_datetime` and `end_datetime` (`"2030-01-07 08:45:00"`, UK time), `title` (a lesson, a
  trip, "Lunch"), `location`, `color_index` and the event's `url`. `action_params` has
  `previousDayUrl`, `todayUrl`, `nextDayUrl` (the next school day), `newTitle` and `total`.
- `GET /guardians/student-ui/calendar-event/student-id/<studentId>/calendar-entry-mapping-id/<id>`
  (live): one event, as a `slide-over` with its type, date and time.
- `GET /guardians/student-ui/calendar/id/<studentId>` (live): a `calendar` component with no data
  of its own. The app does not draw it; use the day data above.

```js
// The task: one day's events
const studentId = "<studentId>";
const day = await arborGet(
  `/guardians/widget-data/get-calendar-data/student-id/${studentId}/date/2026-10-12`,
);
return day.items.map(fieldValues);
```

### Attendance

- `GET /guardians/student-ui/recent-attendance/student-id/<studentId>` (live): sections of
  `property-row`s for the last week and the academic year: Present, Late, Authorised absent and
  Unauthorised absent, each as "10 sessions (100.00%)", and the possible sessions.
- `GET /guardians/student-ui/attendance-by-date/student-id/<studentId>` (live): a `section` per
  week, with a `property-row` per morning and afternoon session (`label: "07 Jan 2030 AM"`,
  `description` the mark's meaning, such as "Present AM" or "Educational trip"), and a
  `property-row-content` with the mark's code and `color`.
- `GET /guardians/student/kpis/id/<studentId>/` (live): the attendance KPI: one item whose
  `data.value` has `measureFormattedValue` ("96.2"), `measureFormattedUnits` ("%"), the
  `comparison…` values for the last 4 weeks, and colours.

### Payments and balances

Read-only here. Paying is not part of this package: see [Payments](#payments).

- `GET /guardians/customer-account-ui/active-payments/student-id/<studentId>` (live): the child's
  accounts (such as Meals, Wraparound Care), each a `property-row` with its balance and the
  account's `url`.
- `GET /guardians/customer-account-ui/dashboard/customer-account-id/<customerAccountId>` (live):
  one account: the balance in the `column-title` ("Meals Balance: £0.00"), a "Top up account"
  button, a term's total, and a `section` per week with a `property-row` per day (the amount spent,
  and a link to that day's payments, linked:
  `/guardians/customer-account-ui/view-payments-on-date/date/<YYYY-MM-DD>/customer-account-id/<customerAccountId>`).
- `GET /guardians/customer-account-ui/invoices-dashboard/student-id/<studentId>` (live): invoices,
  each a `property-row` (the date) with lines for the account, the amount, the items and the
  status ("Paid").
- `GET /guardians/customer-account-ui/top-ups-dashboard/student-id/<studentId>` (live) and
  `…/credit-notes-dashboard/student-id/<studentId>` (linked): top-ups and credit
  notes, in the same shape.
- `GET /guardians/customer-account/payment-total-kpi/student-id/<studentId>` (live): the total
  outstanding, as a KPI.
- `GET /guardians/my-mis-ui/my-basket` (live, empty): the basket. Its `column-title` is "My Basket:
  £0.00"; an empty basket is a `banner`. Meal choices, top-ups, trips and clubs go into the basket,
  and the parent checks it out in one go. `readBasket` reads it: [Booking meals](#booking-meals).

### Trips and clubs

- `GET /guardians/trip-ui/dashboard/student-id/<studentId>` (live): sections for upcoming trips,
  trips open to the child, and past trips, each trip a `property-row` (name, dates) with a link to
  `GET /guardians/trip-ui/overview/trip-id/<tripId>/student-id/<studentId>` (live): registration
  status, location, description, dates, sign-up window, price, and the trip's invoice (total, paid,
  outstanding, last payment). A `widget-attachments` component names the trip's files.
- `GET /guardians/club-ui/dashboard/student-id/<studentId>` (live): the clubs the child is in this
  year, the clubs open to the child (with their timetables), and last year's. A club links to
  `GET /guardians/club-ui/overview/student-id/<studentId>/club-id/<clubId>` (live): registration
  status, memberships (status, fee, dates, sessions), description, membership options and the
  timetable. Wraparound care (breakfast and after-school clubs) links to
  `/guardians/club-ui/wraparound-care-club-overview/student-id/<studentId>/club-id/<clubId>`.

### Schoolwork

- `GET /guardians/student-ui/assignments/student-id/<studentId>` (live): an academic year toggle
  and a `new-kpi-panel` whose `url`,
  `/guardians/student/assignments-kpi/student-id/<studentId>/academic-year-id/<academicYearId>`
  (live), answers three KPIs: due, overdue and submitted, each with its count (`mainValue`) and the
  `url` of its list.
- `GET /guardians/student-ui/assignments-due/student-id/<studentId>/academic-year-id/<academicYearId>`
  (live), and `assignments-overdue` and `assignments-submitted` in the same place (linked): a
  `section` of assignments. The account we read had none, so their rows were not seen.
- `GET /guardians/behaviour-ui/student-behaviour/id/<studentId>` (live): the `info-panel`, and an
  academic year toggle (`…/academic-year-id/<academicYearId>`). The account we read had no
  behaviour records.
- `GET /guardians/student-ui/report-cards/student-id/<studentId>` (live): the report cards. The
  account we read had none. The app downloads a report from a button with `role: "download-file"`
  whose `url` has `format/pdf` in it (code).
- Guardian consultations
  (`/guardians/guardian-consultation-ui/my-consultations/student-id/<studentId>/…`), the school
  shop (`/guardians/school-shop-ui/dashboard/student-id/<studentId>`) and the medical notices on the
  dashboard (`/guardians/medical-ui/add-hearing-test/student-id/<studentId>`) are on the dashboard
  (linked).

### KPIs

A `kpi-panel` or `new-kpi-panel` has a `url`. `GET` it (live). The newer panels answer a list:
`[{ title, subTitle, description, mainValue, mainValueColor, mainValueUnits, min, max, url,
tooltipHTML }]`. The older `kpi-panel` (the dashboard's statistics) answers a data answer whose
item's `data.value` is the KPI.

### Forms: every change

Every change a parent makes in the app is one of Arbor's forms; the app has no other way to
write. **None of this was tried against a real school:** it is from the app's code. A form's page
has:

- one or more `form-action`s: `name` and `url`;
- fields, each with a `targetField` and the action it belongs to (its own `formActionName`, or a
  `form-field-action` inside it): `form-field-hidden` (a `value` the app sends as it is, a string or
  an object such as `{ value: "99_1_0", label, group }`), `form-field-text`,
  `form-field-textarea`, `form-field-combobox` (with `form-field-combobox-option`s),
  `form-field-checkbox`, `form-field-checkbox-group`, `form-field-date`, `form-field-currency`, `form-field-password`; and
  `required: "true"` on a field the form needs;
- a `button` with `role: "form-action"` and the `formActionName` it submits, and
  `form-action-success`s that say what the app does after (`reloadPage`, `serverAction`).

The app posts the action's fields, once, to the action's `url` with `format=json`:

```http
POST <site><form-action url>?format=json
content-type: application/json

{ "fields": { "<targetField>": { "value": <value> }, … } }
```

A combobox's value is the chosen option's `value`. A multi-select's value is the list of chosen
keys. `submitForm(site, action, fields)` sends exactly this, never twice. The answer is
`{ success, action_params }`. On a refusal, `success` is false and
`action_params.validation_errors` has the reasons by field (`__form__` for the whole form). On
success, `action_params.loadPage` or `downloadUrl` can name where the app goes next.

**`submitForm` changes things at the school.** Never call it without the person's say-so for that
change. `readForm(page)` gives the actions and the fields with the values the app would send, so
the person can see the change before you send it.

Meal choices and the basket's checkout are forms too: [Booking meals](#booking-meals).

#### Writing to the school

The form at `/guardians/inbound-in-app-message-ui/message-to-school` (live, as a page) has the
action `message-to-school` (`/guardians/inbound-in-app-message/message-to-school/`) and the fields
`school` (hidden), `subject` and `message` (required). Not tried.

#### Other changes

The profile's edit forms, a club or trip sign-up, consent forms and consultations are forms in the
same way: load the page a row or button links to, and read its form. A `button` with
`role: "load-page"` only opens a page; `role: "form-action"` submits.

#### Payments

Card payments (a basket, a top-up, a trip, a club, the school shop) need a person: see
[How the app pays](#how-the-app-pays).

#### Other calls in the app

- `POST <site>/api/me/language` (code): `{ language }`. It sets the parent's language. Its bearer
  token is the user settings' `jwt`, not the login's.
- `POST <site>/guardians/push-notification-token/create-token/user-id/<userId>` and
  `POST <site>/guardians/push-notification-token/unsubscribe-token` (code): the app's push
  notifications.
- `POST <site>/auth/logout` (code): the app logs out of the school's site.
- `POST <site>/auth/reset-password` (code): `{ email }`, a password reset email.
- `POST <site>/auth/login` with `{ items: [{ username, password }] }` and
  `POST <site>/oauth/authorize` then `/oauth/token` with `client_id: "Arbor"` (code): logins to
  one school's site, which the app keeps for its admin login screen. The parent login is the one
  in step 1.

### Booking meals

**`chooseMeals`, `removeMealChoices` and `checkoutBasket` change the child's meals, and
`checkoutBasket` can spend money.** Never call them without the person's say-so for those meals
and that total. **None of this was tried against a real school:** it is from the app's code, and
from the pages read live (the meal forms, and an empty basket). A meal choice is booked in two
steps, as in the app: the choices go into the basket, and the basket's checkout confirms them. The
form's banner says so: "complete your basket checkout to confirm".

```js
const week = "<the form url of a week, from a menu's weeks: Meals>";
await chooseMeals(site, week, { "<the day's field, meal_provision_…>": "<the option's value>" });
const basket = await readBasket(site); // show the person basket.items and basket.total
const answer = await checkoutBasket({
  site,
  expectedTotal: basket.total, // the total the person agreed to, such as { amount: 0, currency: "GBP" }
  expectedItems: basket.items.length, // optional: the rows the person saw
});
```

#### The basket

`readBasket(site)` sends `GET /guardians/my-mis-ui/my-basket` (live) and returns:

- `total`: the amount in the page's `column-title` ("My Basket: £5.00"), as
  `{ amount: 5, currency: "GBP" }`, or null.
- `items`: each `property-row` of the page, as `{ label, lines, amount }`. Only an empty basket was
  read live, so the rows of a full basket were not seen: show them to the person as they are.
- `empty`: the page's "There are no items in your basket" banner, or no rows.
- `checkout`: the checkout button and its form, or null: `route` (below), `role`, `label`,
  `action` (`{ name, url }`), the action's `fields` (as `readForm` gives them: hidden fields, and a
  choice of how to pay if the school offers one) and the form's `amount` (its `amount` or `payment`
  field), and the whole `page`.

#### Choosing and removing meals

`chooseMeals(site, formUrl, choices)` reads the week's form again (`GET` of `formUrl`, live), and
refuses a day or an option the form does not have. Then it sends the form's
`process-meal-provisions` action once, through `submitForm` (code):

```http
POST <site>/guardians/basket/process-meal-provisions/meal-rotation-menu-id/<menuId>/start-date/<YYYY-MM-DD>/end-date/<YYYY-MM-DD>?format=json

{ "fields": { "student": { "value": { "value": "1_<studentId>_0", … } }, "is_mobile_app": { "value": 1 },
  "meal_provision_<time>": { "value": "<option value>" }, … } }
```

It sends every field of the action that has a value (the hidden fields and each day's current
choice), with the chosen days changed. The answer is `submitForm`'s: check `success` and
`action_params.validation_errors`. A day past its deadline has no field in the form.

`removeMealChoices(site, formUrl)` sends the same form's `delete-meal-provisions` action once
(`POST <site>/guardians/basket-item/delete-meal-provisions/?format=json`, code) with its hidden
`basketItems`: the week's choices that are in the basket. It refuses when there are none.

#### How the app pays

The app reads the checkout button's `role` and the form action's `url` (code):

1. **A plain form action** (`role: "form-action"`, the action's `url` under
   `/guardians/basket/checkout`): the app posts the form, as every other form. No card is part of
   it: this is how a basket that costs nothing (free school meals) or one the form pays otherwise
   would check out. `checkoutBasket` sends only this route. We did not see the server offer it: an
   empty basket has no checkout button.
2. **Stripe's payment sheet** (`role: "sca-credit-card-action"`, a `url` under
   `/guardians/basket/checkout`): the app posts `{ orderType: "basket", client: "parent_app" }` to
   `POST <site>/api/payments/v1/orders`, then the order's `{ orderId }` to
   `POST <site>/api/payments/v1/payment-sessions`, and opens Stripe's payment sheet with the
   answer's `paymentSession.paymentIntent.clientSecret`. The person pays there with a card or Google
   Pay, and Stripe tells Arbor. The app calls nothing after that.
3. **Google Pay** (`role: "sca-credit-card-action"`, when the user settings'
   `payment.enableMobilePay` is on): the phone's wallet makes a Stripe payment method, and the app
   posts the form with its `payment_method_id`.
4. **A card form**: the app takes the card number in its own fields and tokenises it with Stripe,
   and a 3-D Secure check runs in a web view of
   `<site>/?/guardians/arbor-app-ui/process-payment-on-mobile-app-v2?stripeurl=<action>&amount=<amount>&fields=<fields>`.

Routes 2 to 4 need a person, a card or a phone wallet, and often a 3-D Secure check in a browser.
An API cannot finish them, so `checkoutBasket` refuses them with that reason, before it sends
anything: the person pays in the Arbor app or on the Arbor website instead. Paying from a meals
account's balance is not in the app's code: if a school offers it, it is a choice in the checkout
form (route 1), which `readBasket` shows in `checkout.fields`.

#### Checking out

`checkoutBasket({ site, expectedTotal, expectedItems? })` checks out the basket by route 1. In
order, it:

1. Checks its arguments: an `https` site, a total with an amount of 0 or more and a currency, and,
   if given, a whole number of rows of 1 or more.
2. Reads the basket again (`readBasket`).
3. Refuses with every blocker it finds: the basket is empty; its row count is not `expectedItems`; it has
   no total; it has no checkout button; the checkout is a card payment (routes 2 to 4); the button
   has no form action; the action is not under `/guardians/basket/checkout`; the form's amount is
   not the basket's total; a required field, or a choice in the form, has no value.
4. Refuses unless the total is still `expectedTotal`, in pence and currency.
5. Sends one POST of the checkout form, as the app sends a form, and never sends it again:

   ```js
   const url = arborUrl(site, basket.checkout.action.url);
   url.searchParams.set("format", "json");
   await arborFetch(url, {
     method: "POST",
     // every field of the checkout action, at the value readForm gives it
     body: JSON.stringify({ fields: { "<targetField>": { value: "<its value>" } } }),
     redirect: "manual",
     signal: AbortSignal.timeout(30_000),
   });
   ```

6. Returns Arbor's answer, `{ success: true, action_params }`: `action_params.loadPage` can name
   the page the app opens next.

When the answer is unclear (none within 30 seconds, a network failure, HTTP 408 or 5xx, or an
answer that is not `{ success }`), it throws `CheckoutOutcomeUnknownError`: the basket may have been
checked out. Read the basket, the invoices
(`/guardians/customer-account-ui/invoices-dashboard/student-id/<studentId>`) and the week's meal
choices before anything else, and never check out again blindly. Any other HTTP error, or
`success: false` (with Arbor's reasons from `validation_errors`), is "Arbor rejected the checkout":
nothing was booked. Egress sends a request again only after a 401, when Arbor refused the token.

A run script cannot import these helpers. To let the project's agents book meals, give the
worker's class methods that call them: an agent's script calls each as `itx.config.<method>(…)`.
Keep choosing and paying apart, so the person sees the basket's total between the two. For
example, as the recipe's `MEMBER`, with `chooseMeals`, `readBasket` and `checkoutBasket` added to
its `IMPORT`:

```ts
async arborChooseMeals(formUrl: string, choices: Record<string, string>) {
  return chooseMeals("<the school's site>", formUrl, choices);
}
async arborBasket() {
  const { page, ...basket } = await readBasket("<the school's site>");
  return basket;
}
async arborCheckout(expectedTotal: { amount: number; currency: string }, expectedItems?: number) {
  return checkoutBasket({ site: "<the school's site>", expectedTotal, expectedItems });
}
```

Show the person `arborBasket()`'s rows and total, and pass the total they agree to as
`expectedTotal`.

### The login

[`exchange.ts`](src/exchange.ts) does it, as the app does (live):

- `POST https://login.arbor.sc/oauth2/token`, JSON:
  `{ grant_type: "password", username, password, client_id: "ARBOR_PARENT_APP", scope: "GUARDIAN" }`.
  The answer has `access_token`, `expires_in: 3600`, `token_type: "bearer"`, `scope: "GUARDIAN"`,
  `refresh_token` and `schools`, each `{ applicationId, baseUrl, name, location, logo, type }`.
  `baseUrl` is each school's site. The access token is a JWT signed by Arbor's central login
  (`iss: "CENT"`).
- The same URL with `{ grant_type: "refresh_token", refresh_token, client_id: "ARBOR_PARENT_APP" }`
  gives a new access token and a new refresh token. A refresh token that is not valid answers 400
  `{ error: "invalid_grant" }`.
- The app then sends the access token as `authorization: Bearer …` to the school's site. It clears
  the site's cookies before each request: the token is the whole session.

The account we read had no second factor. An account that has one is not covered.

## Notes

- This is the API of Arbor's Android parent app, `com.arboreducation.parentapp` version 51.0.0
  (build 81), an Expo (SDK 54) React Native app whose code is Hermes bytecode (version 96). We read
  it with [hermes-dec](https://github.com/P1sec/hermes-dec), and made read-only calls with one
  parent account on 9 October 2026. Arbor publishes no API for parents; this can break when Arbor
  changes its pages.
- Unofficial: not affiliated with or endorsed by Arbor Education.
- The pages are Arbor's own, built for the app to draw, so their text and order are the school's.
  Read them by component and attribute, not by position.
- To remove it: take the element and its import out of `worker.ts`, and delete `/secrets/arbor`.
  The Dash takes nothing away itself, so once that commit is live, take the card off with its null:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "arbor", card: null } })`.

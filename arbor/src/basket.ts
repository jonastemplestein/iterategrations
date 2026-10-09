import { arborFetch, arborGet, arborUrl, submitForm, type FormAnswer } from "./fetch.js";
import { attributesOf, findNodes, readForm, textOf, type FormField, type UiNode } from "./tree.js";

/** An amount as Arbor shows it ("£12.50", "GBP 12.50"), in pounds. */
export type Money = { amount: number; currency: string };

/** The basket's page, read: what is in it, its total, and how the app would check it out. */
export type Basket = {
  /** the total in the page's title ("My Basket: £12.50"), or null when the page shows none */
  total: Money | null;
  /** each row of the basket, as the page shows it: its label, its lines of text, and an amount */
  items: { label: string; lines: string[]; amount: Money | null }[];
  /** true when the page says the basket is empty, or shows no rows */
  empty: boolean;
  /** the checkout button and its form, or null when the page has none */
  checkout: BasketCheckout | null;
  /** the page itself */
  page: UiNode;
};

/** How the basket would be paid. `form`: a plain form action, which Arbor settles itself (a free
 *  basket, or one the form pays from what it names). `card`: the app's card payment (Stripe's
 *  payment sheet, Google Pay, or a card form with 3-D Secure in a web view), which needs a person
 *  and a card on a phone: `checkoutBasket` refuses it. */
export type BasketCheckout = {
  route: "form" | "card";
  /** the button's role: `form-action` or `sca-credit-card-action` */
  role: string;
  label: string | null;
  /** the form action the button submits: its `name` and the `url` the checkout posts to */
  action: { name: string; url: string } | null;
  /** the action's fields, with their options and the values the app would send */
  fields: FormField[];
  /** the amount in the form (its `amount` or `payment` field), when it has one */
  amount: Money | null;
};

/** The app's own pattern for a basket checkout (`getPaymentJourney`). */
const CHECKOUT_URL = /\/guardians\/basket\/checkout/;

/** "£12.50", "GBP 12.50", a bare "12.50" or a number as money in pounds; null for anything else.
 *  In longer text only an amount marked £ or GBP counts, so a date is never read as money. */
export function moneyOf(text: unknown): Money | null {
  if (typeof text !== "string" && typeof text !== "number") return null;
  const plain = textOf(String(text));
  const digits = /^-?\d[\d,]*(?:\.\d+)?$/.test(plain)
    ? plain
    : /(?:£|GBP\s*)(-?\d[\d,]*(?:\.\d+)?)/.exec(plain)?.[1];
  if (!digits) return null;
  const amount = Number(digits.replace(/,/g, ""));
  return Number.isFinite(amount) ? { amount, currency: "GBP" } : null;
}

/** The checkout button on the basket's page, as the app's ActionButton picks its route. */
function checkoutOf(page: UiNode): BasketCheckout | null {
  const { actions, fields } = readForm(page);
  for (const button of findNodes(page, "button")) {
    const { role, formActionName, label } = attributesOf(button);
    if (role !== "form-action" && role !== "sca-credit-card-action") continue;
    const action = actions.find((candidate) => candidate.name === formActionName) ?? null;
    if (role === "form-action" && !(action && CHECKOUT_URL.test(action.url))) continue;
    const own = fields.filter((field) => field.action === formActionName);
    const amountField = own.find((field) => field.field === "amount" || field.field === "payment");
    return {
      route: role === "form-action" ? "form" : "card",
      role,
      label: typeof label === "string" ? label : null,
      action,
      fields: own,
      amount: amountField ? moneyOf(amountField.value as string) : null,
    };
  }
  return null;
}

/** READS THE BASKET (`GET /guardians/my-mis-ui/my-basket`): its total from the page's title, its
 *  rows, and its checkout button and form. Read-only. The empty basket's page was read live; the
 *  layout of a basket with items was not seen, so `items` is each `property-row` as the page shows
 *  it. */
export async function readBasket(site: string): Promise<Basket> {
  const page = await arborGet<UiNode>(site, "/guardians/my-mis-ui/my-basket");
  const title = findNodes(page, "column-title")
    .map((node) => textOf(node.content))
    .find((text) => /basket/i.test(text));
  const items = findNodes(page, "property-row").map((row) => {
    const { label, value, description } = attributesOf(row);
    const lines = findNodes(row, "property-row-content")
      .map((line) => textOf(line.content))
      .filter(Boolean);
    return {
      label: textOf(typeof label === "string" ? label : ""),
      lines,
      amount: moneyOf(value) ?? moneyOf(description) ?? null,
    };
  });
  const emptyBanner = findNodes(page, "banner").some((banner) => {
    const { title } = attributesOf(banner);
    return typeof title === "string" && /no items/i.test(title);
  });
  return {
    total: title ? moneyOf(title.slice(title.indexOf(":") + 1)) : null,
    items,
    empty: emptyBanner || items.length === 0,
    checkout: checkoutOf(page),
    page,
  };
}

/** A week's meal form (`setup-meal-choice/…/date/<date>`), read again, with its two actions. */
async function weekForm(site: string, formUrl: string) {
  const { actions, fields } = readForm(await arborGet<UiNode>(site, formUrl));
  const action = (name: string) => actions.find((candidate) => candidate.name === name) ?? null;
  return {
    fields,
    process: action("process-meal-provisions"),
    remove: action("delete-meal-provisions"),
  };
}

/** PUTS MEAL CHOICES IN THE BASKET: this writes. `formUrl` is a week's meal form (a day's `url` on
 *  a menu's weeks page); `choices` maps a day's field (`meal_provision_<time>`) to the chosen
 *  option's `value`. It reads the form again, refuses a field or option the form does not have,
 *  then sends the form's `process-meal-provisions` action once, with every field of that action that
 *  has a value, and the chosen days changed. The choices take effect at the basket's checkout.
 *  Code only: never tried against a real school. */
export async function chooseMeals(
  site: string,
  formUrl: string,
  choices: Record<string, string>,
): Promise<FormAnswer> {
  if (!Object.keys(choices).length) throw new Error("No meal choices given");
  const { fields, process } = await weekForm(site, formUrl);
  if (!process) throw new Error("This page has no meal choice form (process-meal-provisions)");
  const own = fields.filter((field) => field.action === process.name);
  for (const [name, value] of Object.entries(choices)) {
    const field = own.find((candidate) => candidate.field === name);
    if (!field?.options) throw new Error(`The meal form has no day ${name}`);
    if (!field.options.some((option) => option.value === value))
      throw new Error(`The meal form has no option ${value} for ${name}`);
  }
  // a field with no value is one the app never set: it sends only the fields it holds
  const values = Object.fromEntries(
    own.filter((field) => field.value !== null).map((field) => [field.field, field.value]),
  );
  return submitForm(site, process.url, { ...values, ...choices });
}

/** TAKES A WEEK'S MEAL CHOICES OUT OF THE BASKET: this writes. It sends the week form's
 *  `delete-meal-provisions` action once, with the basket items the form names. Refuses when the
 *  form names none. Code only: never tried against a real school. */
export async function removeMealChoices(site: string, formUrl: string): Promise<FormAnswer> {
  const { fields, remove } = await weekForm(site, formUrl);
  if (!remove) throw new Error("This page has no form to remove meal choices");
  const own = fields.filter((field) => field.action === remove.name);
  const items = own.find((field) => field.field === "basketItems")?.value;
  if (!Array.isArray(items) || !items.length)
    throw new Error("This week has no meal choices in the basket");
  return submitForm(
    site,
    remove.url,
    Object.fromEntries(own.map((field) => [field.field, field.value])),
  );
}

/** The checkout request went out, and its answer does not show what happened. */
export class CheckoutOutcomeUnknownError extends Error {
  constructor(public readonly expectedTotal: Money) {
    super(
      "The basket checkout outcome is unknown. Read the basket (readBasket), the invoices and the meal choices before anything else; the basket may have been checked out.",
    );
    this.name = "CheckoutOutcomeUnknownError";
  }
}

/** Pounds as pence, so 0.1 + 0.2 compares as 0.30. */
const pence = (money: Money): number => Math.round(money.amount * 100);

/** What stands between the basket and a checkout this package can finish. */
function blockersOf(basket: Basket, expectedItems: number | undefined): string[] {
  const blockers: string[] = [];
  const { checkout } = basket;
  if (basket.empty) blockers.push("The basket is empty");
  if (expectedItems !== undefined && basket.items.length !== expectedItems)
    blockers.push(
      `The basket has ${basket.items.length} rows, not the ${expectedItems} the person reviewed`,
    );
  if (!basket.total || basket.total.amount < 0) blockers.push("The basket's total is unavailable");
  if (!checkout) {
    blockers.push("The basket has no checkout button");
    return blockers;
  }
  if (checkout.route === "card")
    blockers.push(
      "This basket is paid by card (Stripe's payment sheet, Google Pay or a card form with 3-D Secure), which only a person can do in the Arbor app or on the Arbor website",
    );
  if (!checkout.action) blockers.push("The checkout button has no form action");
  else if (!CHECKOUT_URL.test(checkout.action.url))
    blockers.push(`The checkout action is not a basket checkout: ${checkout.action.url}`);
  if (checkout.amount && basket.total && pence(checkout.amount) !== pence(basket.total))
    blockers.push("The checkout form's amount is not the basket's total");
  for (const field of checkout.fields)
    if ((field.required || field.options) && (field.value === null || field.value === ""))
      blockers.push(`The checkout form's ${field.label ?? field.field} has no value`);
  return blockers;
}

/** CHECKS OUT THE BASKET: this books the meals (and anything else in it) and can spend money. It
 *  reads the basket again and refuses on any blocker: an empty basket, a row count that is not
 *  `expectedItems` (when given), no total, no checkout, a
 *  card payment (which needs a person and a card), a form amount that is not the total, a form
 *  field with no value. It refuses unless the total is `expectedTotal`, in amount and currency.
 *  Then it sends the checkout form once, as the app does (`{ fields }` to the action with
 *  `format=json`), and never sends it again. An answer that does not show the outcome is
 *  `CheckoutOutcomeUnknownError`. Code only: never tried against a real school. */
export async function checkoutBasket(options: {
  site: string;
  expectedTotal: Money;
  /** the number of rows (`readBasket().items`) the person reviewed, to refuse a changed basket */
  expectedItems?: number;
}): Promise<FormAnswer> {
  const { site, expectedTotal, expectedItems } = options;
  let siteUrl: URL | null = null;
  try {
    siteUrl = new URL(site);
  } catch {
    siteUrl = null;
  }
  if (
    !siteUrl ||
    siteUrl.protocol !== "https:" ||
    !Number.isFinite(expectedTotal?.amount) ||
    expectedTotal.amount < 0 ||
    typeof expectedTotal.currency !== "string" ||
    !expectedTotal.currency ||
    (expectedItems !== undefined && !(Number.isInteger(expectedItems) && expectedItems > 0))
  )
    throw new Error(
      "The school's site and the reviewed expected total/currency (and item count, if given) are required",
    );
  const basket = await readBasket(site);
  const blockers = blockersOf(basket, expectedItems);
  if (blockers.length) throw new Error(`Checkout blocked: ${blockers.join("; ")}`);
  const total = basket.total!;
  if (pence(total) !== pence(expectedTotal) || total.currency !== expectedTotal.currency)
    throw new Error("The basket's total has changed; review the basket again");
  const { action, fields } = basket.checkout!;
  const url = arborUrl(site, action!.url);
  url.searchParams.set("format", "json");
  let response: Response;
  try {
    response = await arborFetch(url, {
      method: "POST",
      body: JSON.stringify({
        fields: Object.fromEntries(fields.map((field) => [field.field, { value: field.value }])),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CheckoutOutcomeUnknownError(expectedTotal);
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408)
      throw new CheckoutOutcomeUnknownError(expectedTotal);
    throw new Error(
      `Arbor rejected the checkout (HTTP ${response.status}). Read the basket before trying again.`,
    );
  }
  const answer = (await response.json().catch(() => null)) as FormAnswer | null;
  if (!answer || typeof answer !== "object" || typeof answer.success !== "boolean")
    throw new CheckoutOutcomeUnknownError(expectedTotal);
  if (!answer.success) {
    const reasons = Object.values(answer.action_params?.validation_errors ?? {})
      .flat()
      .map((reason) => textOf(String(reason)))
      .filter(Boolean);
    throw new Error(
      `Arbor rejected the checkout${reasons.length ? `: ${reasons.join("; ")}` : ""}. Read the basket before trying again.`,
    );
  }
  return answer;
}

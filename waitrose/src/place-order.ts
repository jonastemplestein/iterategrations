import { graphql, waitroseFetch } from "./fetch.js";
import { OPERATIONS } from "./operations.js";

export type Price = { amount: number; currencyCode: string };

type Totals = Record<string, Price | null>;

/** What Waitrose's instant checkout answers: the order it took, not a payment receipt. */
export type PlacedOrder = {
  customerOrderId: string;
  totals: { estimated: Totals | null; actual: Totals | null };
  slots: Array<{
    branchId: number;
    branchName: string;
    type: string;
    startDateTime: string;
    endDateTime: string;
    amendOrderCutoffDateTime?: string | null;
    status?: string | null;
  }>;
};

/** The place request went out, and its answer does not show what happened. */
export class CheckoutOutcomeUnknownError extends Error {
  constructor(public readonly orderId: string) {
    super(
      `Checkout outcome is unknown for order ${orderId}. Check getOrder before retrying; the order may have been placed.`,
    );
    this.name = "CheckoutOutcomeUnknownError";
  }
}

type TrolleyFailure = { type: string; message: string };

/** The fields of `GetTrolley` and `CurrentSlot` the review reads. Waitrose can leave any of them
 *  out, and each one it leaves out is a blocker. */
type Trolley = {
  instantCheckout?: string | null;
  checkoutReadiness?: { slotTypeValid: boolean } | null;
  failures: TrolleyFailure[] | null;
  trolley: {
    orderId: string;
    trolleyItems: unknown[] | null;
    trolleyTotals: {
      minimumSpendThresholdMet?: boolean | null;
      trolleyItemCounts?: { hardConflicts: number } | null;
      totalEstimatedCost: Price | null;
    } | null;
  } | null;
};
type Slot = {
  slotType: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  expiryDateTime: string | null;
};

/** Why a checkout cannot go ahead. */
export type CheckoutBlockerCode =
  | "NO_CURRENT_ORDER"
  | "TROLLEY_ORDER_MISMATCH"
  | "TROLLEY_FAILURES"
  | "INSTANT_CHECKOUT_NOT_ALLOWED"
  | "SLOT_INVALID"
  | "SLOT_EXPIRED"
  | "TROLLEY_EMPTY"
  | "MINIMUM_SPEND_NOT_MET"
  | "HARD_CONFLICTS"
  | "TOTAL_UNAVAILABLE";

export type CheckoutBlocker = { code: CheckoutBlockerCode; message: string };

/** What a read-only review found. `ready` means that it found no blocker at the time of the reads.
 *  It does not mean that Waitrose will accept the order. A `null` is a value Waitrose did not give. */
export type CheckoutReview = {
  orderId: string | null;
  ready: boolean;
  blockers: CheckoutBlocker[];
  instantCheckout: string | null;
  slotTypeValid: boolean | null;
  slot: Slot | null;
  itemCount: number | null;
  minimumSpendThresholdMet: boolean | null;
  hardConflicts: number | null;
  estimatedTotal: Price | null;
  trolleyFailures: TrolleyFailure[];
};

const NO_CURRENT_ORDER = "No current order available for checkout";

/** The estimated total, when Waitrose gave a usable one. */
function usableTotal(total: Price | null | undefined): Price | null {
  if (!total || !Number.isFinite(total.amount) || total.amount < 0 || !total.currencyCode)
    return null;
  return { amount: total.amount, currencyCode: total.currencyCode };
}

/** What stands between the current order and an instant checkout. */
function blockersOf(orderId: string, answer: Trolley | null, slot: Slot | null): CheckoutBlocker[] {
  const blockers: CheckoutBlocker[] = [];
  const block = (code: CheckoutBlockerCode, message: string) => blockers.push({ code, message });
  const trolley = answer?.trolley;
  const totals = trolley?.trolleyTotals;
  if (trolley?.orderId !== orderId)
    block("TROLLEY_ORDER_MISMATCH", "The trolley does not match the current order");
  if (answer?.failures?.length) block("TROLLEY_FAILURES", "Waitrose reported trolley failures");
  if (answer?.instantCheckout !== "ALLOWED")
    block(
      "INSTANT_CHECKOUT_NOT_ALLOWED",
      `Instant checkout is ${answer?.instantCheckout ?? "unknown"}; complete payment setup or checkout on the Waitrose website`,
    );
  if (
    answer?.checkoutReadiness?.slotTypeValid !== true ||
    !slot ||
    !["DELIVERY", "COLLECTION"].includes(slot.slotType ?? "") ||
    !Number.isFinite(Date.parse(slot.startDateTime ?? "")) ||
    !Number.isFinite(Date.parse(slot.endDateTime ?? ""))
  )
    block("SLOT_INVALID", "A valid delivery or collection slot is required");
  if (slot?.expiryDateTime && !(Date.parse(slot.expiryDateTime) > Date.now()))
    block("SLOT_EXPIRED", "The slot reservation has expired or its expiry is unknown");
  if (!trolley?.trolleyItems?.length) block("TROLLEY_EMPTY", "The trolley is empty");
  if (totals?.minimumSpendThresholdMet !== true)
    block("MINIMUM_SPEND_NOT_MET", "The minimum spend requirement is not met or unknown");
  if (totals?.trolleyItemCounts?.hardConflicts !== 0)
    block("HARD_CONFLICTS", "Resolve trolley conflicts before checkout");
  if (!usableTotal(totals?.totalEstimatedCost))
    block("TOTAL_UNAVAILABLE", "The estimated total is unavailable");
  return blockers;
}

/** Reads the trolley and the slot of `orderId` (two GraphQL queries), and reviews them. The answer
 *  keeps only the slot fields below: `CurrentSlot` also answers the address. */
async function reviewOrder(orderId: string): Promise<CheckoutReview> {
  const [{ getTrolley: answer }, { currentSlot: slot }] = await Promise.all([
    graphql<{ getTrolley: Trolley | null }>(OPERATIONS.GetTrolley, { orderId }),
    graphql<{ currentSlot: Slot | null }>(OPERATIONS.CurrentSlot, {
      input: { customerOrderId: orderId },
    }),
  ]);
  const blockers = blockersOf(orderId, answer, slot);
  const trolley = answer?.trolley;
  const totals = trolley?.trolleyTotals;
  return {
    orderId,
    ready: blockers.length === 0,
    blockers,
    instantCheckout: answer?.instantCheckout ?? null,
    slotTypeValid: answer?.checkoutReadiness?.slotTypeValid ?? null,
    slot: slot
      ? {
          slotType: slot.slotType,
          startDateTime: slot.startDateTime,
          endDateTime: slot.endDateTime,
          expiryDateTime: slot.expiryDateTime,
        }
      : null,
    itemCount: trolley?.trolleyItems?.length ?? null,
    minimumSpendThresholdMet: totals?.minimumSpendThresholdMet ?? null,
    hardConflicts: totals?.trolleyItemCounts?.hardConflicts ?? null,
    estimatedTotal: usableTotal(totals?.totalEstimatedCost),
    trolleyFailures: (answer?.failures ?? []).map(({ type, message }) => ({ type, message })),
  };
}

/** Reports what stands between the account's current order and an instant checkout, from fresh
 *  reads. READ-ONLY: it sends three GraphQL queries and never the place request, so it spends
 *  nothing. `placeOrder` applies the same review. An HTTP or GraphQL error throws, as `graphql`
 *  does. */
export async function reviewCheckout(): Promise<CheckoutReview> {
  const { shoppingContext } = await graphql<{
    shoppingContext: { customerOrderId: string | null };
  }>(OPERATIONS.GetShoppingContext);
  if (shoppingContext.customerOrderId) return reviewOrder(shoppingContext.customerOrderId);
  return {
    orderId: null,
    ready: false,
    blockers: [{ code: "NO_CURRENT_ORDER", message: NO_CURRENT_ORDER }],
    instantCheckout: null,
    slotTypeValid: null,
    slot: null,
    itemCount: null,
    minimumSpendThresholdMet: null,
    hardConflicts: null,
    estimatedTotal: null,
    trolleyFailures: [],
  };
}

/** PLACES THE ACCOUNT'S CURRENT ORDER through the app's instant checkout, paid by the account's own
 *  payment setup: money moves. It reviews the checkout from fresh reads (the shopping context, the
 *  trolley, the current slot) and refuses on any blocker, or when the estimated total is not
 *  `expectedTotal`. Then it sends one POST and never sends it again. An answer that does not show
 *  the order is `CheckoutOutcomeUnknownError`. Totals are estimates: Waitrose can change them after
 *  this review. */
export async function placeOrder(options: {
  orderId: string;
  expectedTotal: Price;
}): Promise<PlacedOrder> {
  const { orderId, expectedTotal } = options;
  if (
    !/^[A-Za-z0-9_-]+$/.test(orderId) ||
    !Number.isFinite(expectedTotal?.amount) ||
    expectedTotal.amount < 0 ||
    !expectedTotal.currencyCode
  )
    throw new Error("A reviewed order ID and expected total/currency are required");
  const { shoppingContext } = await graphql<{
    shoppingContext: { customerOrderId: string | null };
  }>(OPERATIONS.GetShoppingContext);
  if (!shoppingContext.customerOrderId) throw new Error(NO_CURRENT_ORDER);
  if (shoppingContext.customerOrderId !== orderId)
    throw new Error("The current order has changed; review checkout again");
  const review = await reviewOrder(orderId);
  if (!review.ready)
    throw new Error(
      `Checkout blocked: ${review.blockers.map(({ message }) => message).join("; ")}`,
    );
  const total = review.estimatedTotal;
  if (total?.amount !== expectedTotal.amount || total?.currencyCode !== expectedTotal.currencyCode)
    throw new Error("The estimated total has changed; review checkout again");
  let response: Response;
  try {
    response = await waitroseFetch(
      `https://www.waitrose.com/api/order-orchestration-prod/v1/orders/${encodeURIComponent(orderId)}/place`,
      {
        method: "POST",
        body: JSON.stringify({ instantCheckout: true, event: "PLACE" }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new CheckoutOutcomeUnknownError(orderId);
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408)
      throw new CheckoutOutcomeUnknownError(orderId);
    throw new Error(
      `Waitrose checkout rejected (${response.status}). Check the order and checkout eligibility before retrying.`,
    );
  }
  const placed = (await response.json().catch(() => null)) as PlacedOrder | null;
  if (
    !placed ||
    placed.customerOrderId !== orderId ||
    !placed.totals ||
    typeof placed.totals !== "object" ||
    Array.isArray(placed.totals) ||
    !Array.isArray(placed.slots)
  )
    throw new CheckoutOutcomeUnknownError(orderId);
  return placed;
}

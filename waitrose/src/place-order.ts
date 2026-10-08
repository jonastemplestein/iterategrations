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

/** The fields of `GetTrolley` and `CurrentSlot` the review reads. */
type Trolley = {
  instantCheckout?: string | null;
  checkoutReadiness?: { slotTypeValid: boolean } | null;
  failures: { type: string; message: string }[] | null;
  trolley: {
    orderId: string;
    trolleyItems: unknown[];
    trolleyTotals: {
      minimumSpendThresholdMet?: boolean;
      trolleyItemCounts?: { hardConflicts: number };
      totalEstimatedCost: Price;
    };
  };
};
type Slot = {
  slotType: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  expiryDateTime: string | null;
};

/** What stands between the current order and an instant checkout. */
function blockersOf(orderId: string, trolley: Trolley, slot: Slot | null): string[] {
  const blockers: string[] = [];
  const { trolleyItems, trolleyTotals } = trolley.trolley;
  if (trolley.trolley.orderId !== orderId)
    blockers.push("The trolley does not match the current order");
  if (trolley.failures?.length) blockers.push("Waitrose reported trolley failures");
  if (trolley.instantCheckout !== "ALLOWED")
    blockers.push(
      `Instant checkout is ${trolley.instantCheckout ?? "unknown"}; complete payment setup or checkout on the Waitrose website`,
    );
  if (
    trolley.checkoutReadiness?.slotTypeValid !== true ||
    !slot ||
    !["DELIVERY", "COLLECTION"].includes(slot.slotType ?? "") ||
    !Number.isFinite(Date.parse(slot.startDateTime ?? "")) ||
    !Number.isFinite(Date.parse(slot.endDateTime ?? ""))
  )
    blockers.push("A valid delivery or collection slot is required");
  if (slot?.expiryDateTime && !(Date.parse(slot.expiryDateTime) > Date.now()))
    blockers.push("The slot reservation has expired or its expiry is unknown");
  if (!trolleyItems.length) blockers.push("The trolley is empty");
  if (trolleyTotals.minimumSpendThresholdMet !== true)
    blockers.push("The minimum spend requirement is not met or unknown");
  if (trolleyTotals.trolleyItemCounts?.hardConflicts !== 0)
    blockers.push("Resolve trolley conflicts before checkout");
  const total = trolleyTotals.totalEstimatedCost;
  if (!total || !Number.isFinite(total.amount) || total.amount < 0 || !total.currencyCode)
    blockers.push("The estimated total is unavailable");
  return blockers;
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
  if (!shoppingContext.customerOrderId) throw new Error("No current order available for checkout");
  if (shoppingContext.customerOrderId !== orderId)
    throw new Error("The current order has changed; review checkout again");
  const [{ getTrolley: trolley }, { currentSlot: slot }] = await Promise.all([
    graphql<{ getTrolley: Trolley }>(OPERATIONS.GetTrolley, { orderId }),
    graphql<{ currentSlot: Slot | null }>(OPERATIONS.CurrentSlot, {
      input: { customerOrderId: orderId },
    }),
  ]);
  const blockers = blockersOf(orderId, trolley, slot);
  if (blockers.length) throw new Error(`Checkout blocked: ${blockers.join("; ")}`);
  const total = trolley.trolley.trolleyTotals.totalEstimatedCost;
  if (total.amount !== expectedTotal.amount || total.currencyCode !== expectedTotal.currencyCode)
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

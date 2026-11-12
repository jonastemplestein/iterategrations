// Monzo's own API (https://api.monzo.com) for a mind's agents, by tool name. The sign-in is the secret
// `/secrets/monzo`: the platform's own OAuth sign-in with Monzo (the recipe's step 1), which it refreshes. The code
// never sees a token: it sends a placeholder, and the platform puts the token in as the request leaves.
//
// Monzo asks the person to approve the access in the Monzo app once after each sign-in, and again about every 90
// days: until they do, every call answers 403.

/** The mind, as `monzoApi` uses it: what a config worker's `itx` already has. */
export type MonzoApiItx = { fetch(request: Request): Promise<Response> };

const API = "https://api.monzo.com";
const AUTHORIZATION = 'Bearer getSecret("/secrets/monzo", { field: "accessToken" })';
type Args = Record<string, any>;

async function send<T = any>(
  itx: MonzoApiItx,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: URLSearchParams | object,
): Promise<T> {
  const form = body instanceof URLSearchParams;
  const init: RequestInit = {
    method,
    headers: {
      accept: "application/json",
      authorization: AUTHORIZATION,
      ...(body !== undefined && {
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      }),
    },
  };
  // most Monzo writes take a form; receipts take JSON
  if (body !== undefined) init.body = form ? body.toString() : JSON.stringify(body);
  const response = await itx.fetch(new Request(API + path, init));
  const text = await response.text();
  if (!response.ok) {
    const why =
      response.status === 401 || response.status === 403
        ? "Monzo has not approved this sign-in (the Monzo app asks the person once, and again about every 90 days), the grant was revoked, or the resource is not this sign-in's"
        : "Monzo refused the request";
    throw new Error(
      `Monzo ${method} ${path.split("?")[0]}: ${response.status}. ${why}. ${text.slice(0, 200)}`,
    );
  }
  return (text.trim() ? JSON.parse(text) : undefined) as T;
}

const formatAmount = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${amount} ${currency} minor units`;
  }
};
const query = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/** One call of Monzo's API by tool name: `await monzoApi(itx, "get_balance", { account_id })`. It answers
 *  Monzo's JSON, and throws with Monzo's status when Monzo refuses. The README lists the tools. */
export async function monzoApi(itx: MonzoApiItx, tool: string, a: Args = {}): Promise<unknown> {
  switch (tool) {
    case "whoami":
      return send(itx, "GET", "/ping/whoami");
    case "list_accounts":
      return { accounts: (await send(itx, "GET", "/accounts")).accounts };
    case "get_balance": {
      const result = await send(itx, "GET", `/balance?${query({ account_id: a.account_id })}`);
      return {
        ...result,
        balance_formatted: formatAmount(result.balance, result.currency),
        spend_today_formatted: formatAmount(result.spend_today, result.currency),
      };
    }
    case "list_pots":
      return send(itx, "GET", `/pots?${query({ current_account_id: a.current_account_id })}`);
    case "list_transactions": {
      const limit = a.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new Error("monzo: limit is 1 to 50");
      const params = new URLSearchParams({ account_id: a.account_id, limit: String(limit) });
      params.append("expand[]", "merchant");
      if (a.since) params.set("since", a.since);
      if (a.before) params.set("before", a.before);
      const { transactions } = await send<{ transactions: Args[] }>(
        itx,
        "GET",
        `/transactions?${params.toString()}`,
      );
      return {
        transactions: transactions.map((t) => ({
          id: t.id,
          account_id: t.account_id,
          created: t.created,
          settled: t.settled,
          amount: t.amount,
          currency: t.currency,
          formatted: formatAmount(t.amount, t.currency),
          description: t.description,
          merchant: typeof t.merchant === "object" ? t.merchant?.name : t.merchant,
          category: t.category,
          decline_reason: t.decline_reason || undefined,
          is_load: Boolean(t.is_load),
        })),
      };
    }
    case "get_transaction": {
      const { transaction } = await send(
        itx,
        "GET",
        `/transactions/${encodeURIComponent(a.transaction_id)}?expand%5B%5D=merchant`,
      );
      return {
        transaction: {
          ...transaction,
          formatted: formatAmount(transaction.amount, transaction.currency),
        },
      };
    }
    case "list_webhooks":
      // Monzo shows a client only the webhooks that client registered
      return send(itx, "GET", `/webhooks?${query({ account_id: a.account_id })}`);
    case "register_webhook":
      if (!String(a.url ?? "").startsWith("https://"))
        throw new Error("monzo: a webhook's address is https");
      return send(
        itx,
        "POST",
        "/webhooks",
        new URLSearchParams({ account_id: a.account_id, url: a.url }),
      );
    case "delete_webhook":
      await send(itx, "DELETE", `/webhooks/${encodeURIComponent(a.webhook_id)}`);
      return { deleted: a.webhook_id };
    case "create_receipt": {
      const { currency } = a;
      const line = (value: Args) => ({ ...value, currency });
      const result = await send(itx, "PUT", "/transaction-receipts", {
        ...a,
        items: (a.items ?? []).map(({ sub_items, ...item }: Args) => ({
          ...line(item),
          sub_items: (sub_items ?? []).map(line),
        })),
        taxes: (a.taxes ?? []).map(line),
        payments: (a.payments ?? []).map(line),
      });
      return {
        saved: true,
        external_id: a.external_id,
        transaction_id: a.transaction_id,
        receipt_id: result?.receipt_id,
      };
    }
    case "get_receipt":
      return send(itx, "GET", `/transaction-receipts?${query({ external_id: a.external_id })}`);
    case "delete_receipt":
      await send(itx, "DELETE", `/transaction-receipts?${query({ external_id: a.external_id })}`);
      return { deleted: a.external_id };
    default:
      throw new Error(`monzo: ${JSON.stringify(tool)} is no tool; the recipe's README lists them`);
  }
}

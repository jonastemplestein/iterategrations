import { pathToFileURL } from "node:url";
import { zincRequest } from "./transport.js";
import type { Fetch } from "./transport.js";

/** Private one-time setup, never exposed to agents as an RPC method. */
export async function registerAmazonAccount(input: {
  apiKey: string;
  email: string;
  password: string;
  fetch: Fetch;
}): Promise<{ retailerCredentialsId: string; retailerId: number }> {
  if (!input.apiKey || !input.email || !input.password)
    throw new Error("amazon: setup needs ZINC_API_KEY, AMAZON_EMAIL and AMAZON_PASSWORD");
  const response = await zincRequest(input.fetch, `Bearer ${input.apiKey}`, "/managed-accounts", {
    email: input.email,
    password: input.password,
    retailer: "amazon-uk",
  });
  if (
    typeof response.short_id !== "string" ||
    !/^zn_acct_[a-zA-Z0-9]+$/.test(response.short_id) ||
    response.retailer !== "amazon-uk" ||
    typeof response.retailer_id !== "number"
  )
    throw new Error(
      "amazon: Zinc did not link the managed account to Amazon UK; inspect its dashboard",
    );
  return { retailerCredentialsId: response.short_id, retailerId: response.retailer_id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const account = await registerAmazonAccount({
      apiKey: process.env.ZINC_API_KEY ?? "",
      email: process.env.AMAZON_EMAIL ?? "",
      password: process.env.AMAZON_PASSWORD ?? "",
      fetch: (request) => globalThis.fetch(request),
    });
    console.log(JSON.stringify(account));
  } catch (error) {
    // Helpers never include raw request material or provider messages in errors.
    console.error(error instanceof Error ? error.message : "amazon: setup failed");
    process.exitCode = 1;
  }
}

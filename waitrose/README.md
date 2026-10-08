# Waitrose

The Waitrose grocery API (search, trolley, orders, delivery slots, checkout) as a Cap'n Web RPC
target in an iterate project, logged in with the person's own Waitrose account. The project never
holds the password or the token: they live in a secret, and iterate's egress swaps the token into
each request and logs in again when Waitrose answers 401.

It is the package `iterate-waitrose`: one element, `waitrose(…)`, in the `integrations` array of the
project's config worker. The project's Integrations page in the Dash shows a Waitrose card ("Set up
by your coding agent" until the account's secret exists, with a link to this recipe).

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 1. The account, as a secret

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/waitrose",
    egress: { urls: ["https://www.waitrose.com"] },
    description:
      "Your Waitrose account: the email and password you sign in to waitrose.com with. They are only ever sent to waitrose.com.",
    fields: [
      { name: "username", label: "Email" },
      { name: "password", label: "Password" },
    ],
  });
```

Send the person the returned `url` and wait until they say it is saved. Then give the secret its
login, which is the module below (`EXCHANGE_SOURCE` in the package; it runs in a jail that can reach
`www.waitrose.com` and nothing else). Pass its text as `source`:

```js
async (itx) =>
  itx.secrets.set(
    "/secrets/waitrose",
    {},
    {
      urls: ["https://www.waitrose.com"],
      merge: true, // keeps the username and password the person saved
      refresh: { kind: "worker", source: `<the module below, as a string>` },
    },
  );
```

<!-- prettier-ignore -->
```js
export async function exchange(material, fetch) {
	const graphqlUrl = "https://www.waitrose.com/api/graphql-prod/graph/live";
	const newSession = "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";
	const { username, password } = material;
	if (typeof username !== "string" || !username || typeof password !== "string" || !password) throw new Error("waitrose: the secret's material has no \"username\" and \"password\"");
	const response = await fetch(graphqlUrl, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"user-agent": "Waitrose/3.9.1 (Android)"
		},
		body: JSON.stringify({
			query: newSession,
			variables: { input: {
				clientId: "ANDROID_APP",
				password,
				username
			} }
		})
	});
	if (response.status === 401) throw new Error("waitrose: login refused (HTTP 401): check the secret's username and password");
	if (!response.ok) throw new Error(`waitrose: login answered HTTP ${response.status}`);
	const session = (await response.json().catch(() => null))?.data?.generateSession;
	const failure = session?.failures?.[0]?.type;
	if (failure) throw new Error(`waitrose: login refused (${failure})`);
	if (!session?.accessToken) throw new Error("waitrose: login returned no accessToken");
	return {
		...material,
		accessToken: session.accessToken
	};
}
```

## 2. Serve the API from the project's config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the imports and the element to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it. The route is for
members only: the API acts as the person's Waitrose account, `placeOrder` included.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-waitrose";
const IMPORT = `import { newWorkersRpcResponse as iterateRpcResponse } from "iterate/sdk";
import { waitrose } from "iterate-waitrose";`;
const ELEMENT = "waitrose({ rpcResponse: iterateRpcResponse })";
const MEMBER = "";
const FILES = {};
```

`waitrose(…)` answers the project's `waitrose` host: the worker hands it every request there, and
every event. It serves a `Waitrose` over Cap'n Web with `rpcResponse`, which is iterate/sdk's
`newWorkersRpcResponse` (the package never imports iterate). Its install hook
(`project/worker-updated`) puts the Waitrose card on the Dash.

### By hand, or copy the source

By hand: [add-to-a-project.md](../add-to-a-project.md#by-hand), with the imports and the element above.
To copy the source instead, read [`src/client.ts`](src/client.ts) (the API, no dependencies),
[`src/index.ts`](src/index.ts) (the RPC target and `waitrose()`) and
[`src/exchange.ts`](src/exchange.ts), and commit them to `/repos/config` under `waitrose/`. You own
the copy. The import then reads `from "./waitrose/index.ts"`.

## 3. Use it

```js
async (itx) => {
  const waitrose = await itx.connectToCapnweb(await itx.url({ routingSlug: "waitrose" }));
  const found = await waitrose.searchProducts("oat milk", { size: 3 });
  waitrose.close();
  return found.products.map((p) => ({ line: p.lineNumber, name: p.name, price: p.displayPrice }));
};
```

Real products back is the proof. The first call reads the account's shopping context, so it takes
a moment. The route answers `401` to anyone who is not a signed-in member of the project; if this
call gets one, dial the URL from a client that is signed in (any Cap'n Web client works). Every method of [`WaitroseApi`](src/client.ts) is there: `searchProducts`,
`browseProducts`, `getProductsByLineNumbers`, `getTrolley`, `addToTrolley`, `removeFromTrolley`,
`emptyTrolley`, `getOrders`, `getOrder`, `getSlotDays`, `bookSlot`, `getCheckout`, and more.

**`placeOrder` spends money.** It places the order in the account's current trolley through
Waitrose's instant checkout. It refuses unless `getCheckout` shows nothing blocking it and the
`expectedTotal` passed is the trolley's current estimate, and it never retries. Never call it
without the person's say-so for that order.

## Notes

- The API and login are the Waitrose Android app's (v3.9.1) GraphQL and REST services at
  `www.waitrose.com/api/graphql-prod/graph/live` and its `content-prod` and `products-prod`
  siblings. Waitrose publishes no API; this can break when the app changes.
- Waitrose's login refuses a request that already carries a token, so the exchange sends none.
- Adapted from [jonastemplestein/waitrose](https://github.com/jonastemplestein/waitrose), which is
  the same client as a CLI.
- To remove it: take the element and its imports out of `worker.ts`, and delete `/secrets/waitrose`.
  The Dash takes nothing away itself, so once that commit is live, take the card off with its null:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "waitrose", card: null } })`.

# Amazon UK agent shopping

Checked 6 October 2026. The [integration recipe](../amazon/README.md) uses a local
`iterate provide` bridge. Chrome establishes the session. Node then calls the website's HTTP
endpoints directly.

## What the experiment established

I captured requests while navigating Amazon UK in Jonas's real Chrome through Playwriter.
The session was already signed into Amazon Business. I searched for pens, opened a product,
added it to the basket, changed its quantity and selection, chose a stored delivery address,
and reached the final order review. That initial probe did not submit an order.

A later, explicitly approved purchase used the self-hosted Iterate MCP server. Every shopping
call ran through `itx.amazon`, lent by the local HTTP bridge. It ordered one pack of vanilla
Huel Black Edition ready-to-drink bottles for the reviewed total. An exact order-number search
in Amazon's order history confirmed a new order, the total and the delivery status.
The receipt and account details remain in the private project. The original basket was restored.

The website uses a mix of JSON resources, HTML pages and form submissions. The captured routes
include:

| Function                    | Website route                                                            | Format                                           |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Search                      | `GET /s`                                                                 | HTML result rows, ASINs and displayed prices     |
| Product                     | `GET /dp/{ASIN}`                                                         | HTML offer form and page token                   |
| Product resources           | `GET /api/marketplaces/A1F83G8C2ARO7P/products/{ASIN}`                   | JSON resource envelopes                          |
| Basket read                 | `GET /cart/add-to-cart/get-cart-items?clientName=SiteWideActionExecutor` | JSON ASINs, sellers and quantities               |
| Add item                    | `POST /cart/add-to-cart`                                                 | Form data with offer, quantity and CSRF token    |
| Quantity, selection, delete | `POST /cart/ref=ox_sc_cart_actions_1`                                    | Form data with an action payload and CSRF header |
| Start purchase view         | `GET /checkout/entry/cart?isPreinit=1&partialCheckoutCart=1&…`           | Checkout HTML                                    |
| Business address            | `POST /checkout/p/{purchase}/business-address/continue`                  | Stored address choice and request token          |
| Review                      | `GET /checkout/p/{purchase}/spc`                                         | Delivery, payment, items and final total         |
| Final purchase form         | `POST /checkout/p/{purchase}/spc/place-order`                            | Guarded POST; one approved order confirmed       |
| Business order history      | `POST /ab/your-orders/orderHistory`                                      | Read-only HTML results with a page CSRF token    |

I replayed authenticated reads from Node with cookies exported from the task tab. Search,
product and basket pages returned HTTP 200. Basket JSON also returned valid items. This proves
that browser clicks are not required for these requests once a working session exists.

A live Node probe then verified search, product details, add, quantity change, selection,
checkout review, stored-address selection, a refreshed review and delete. It restored the
original basket. The fresh review matched the earlier contents and total.

The implemented client loads current forms and tokens. It does not hard-code token values.
The bridge keeps cookies, passwords and hidden checkout fields away from the agents. Agents
receive product results, basket records and visible checkout choices.

One checkout detail matters: Chrome initializes a fresh purchase view. The direct Business
entry route can reuse an earlier view containing deselected items. The client consumes the
fresh checkout HTML returned by the initialization request. It records the resulting purchase
URL for subsequent reviews. Follow-up requests use a page CSRF token and Amazon checkout AJAX
headers. They return JSON with HTML panels; the client applies those panels to the saved page.

The [sanitized live HTTP trace](../research_notes/Amazon%20UK%20agent%20shopping/http_trace.json)
records request methods, paths, field names and status codes. It contains no cookies, token
values, addresses or payment details. Raw capture data remains private and outside the repository.

## What remains unverified

The client implements a single guarded order POST. Purchases are disabled unless the owner sets
a GBP cap. The caller must pass the exact total and current review ID. The client checks a fresh
review before it submits. It consumes the review before the request and never retries it.
The first live submission returned no readable confirmation text. The item left the basket,
but that alone was not treated as proof. The client now reads Business order-history results
and handles HTML fragments that have no `body` element. An exact order-number search verified
the live order. Future callers must also verify an order record after submission.

The live account is Amazon Business. A fresh ordinary-account login, new-address entry, new-card
entry, MFA flows and other checkout variants need further testing. The credentials-file login
helper is implemented, but the tested bootstrap exported an existing signed-in session.
A person must complete authentication challenges.

The website protocol is not documented as a public shopping API. Network visibility proves
technical access; it does not establish Amazon's support commitment for these endpoints.

## Official API access

Amazon Business supplies official UK buyer APIs:
[Product Search](https://docs.business.amazon.com/docs/product-search-api-overview),
[Cart](https://docs.business.amazon.com/docs/cart-api-overview), and
[Ordering](https://docs.business.amazon.com/docs/ordering-api). Cart can add and modify items,
estimate totals and return buying-option identifiers for ordering.

This route needs developer onboarding, approved roles, Business account setup and OAuth consent.
Email and password alone do not provide API authorization.
[API roles](https://docs.business.amazon.com/docs/amazon-business-roles),
[website authorization](https://docs.business.amazon.com/docs/website-authorization-workflow).

Login with Amazon grants profile scopes.
[Its documented profile access](https://developer.amazon.com/docs/login-with-amazon/obtain-customer-profile.html)
does not grant buyer checkout authority. Affiliate catalog APIs and seller SP-API serve different
roles.

## Other ordering services

The earlier [Zinc adapter](../amazon/ZINC.md) remains as an alternative. Its live retailer check
reports Amazon UK as orderable with customer credentials, but its support is marked observed
and its published schemas do not consistently describe GB or UK currency handling.
[Retailer check](https://www.zinc.com/docs/v2/api-reference/retailers/check-retailer),
[create order](https://www.zinc.com/docs/v2/api-reference/orders/create-order).

Zinc stores the Amazon email and password at private registration. Normal agent calls use a Zinc
API key and managed-account ID. Its sandbox protocol was tested, but that does not prove Amazon UK
login or checkout.
[Managed accounts](https://www.zinc.com/docs/v2/api-reference/managed-accounts/create-managed-account),
[sandbox](https://www.zinc.com/docs/v2/api-reference/introduction/sandbox).

Rye's documented v2 constraints are US-only and do not support login or non-guest checkout.
[Developer notes](https://rye.com/docs/api-v2/developer-notes).

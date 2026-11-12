# Amazon UK agent shopping: official APIs

## Can an ordinary Amazon.co.uk retail account use an official API to search, authenticate, place orders, and retrieve orders?

### Takeaway

I found no documented official retail-buyer checkout or order-history API for an ordinary Amazon.co.uk account. Login with Amazon authenticates a user to the integrating application and returns only profile data; Amazon’s affiliate APIs expose catalog data and link customers to Amazon, but do not expose buyer checkout.

### Cited Findings

- Login with Amazon uses OAuth 2.0. Its authorization-code flow requires the user to sign in on an Amazon page and consent, after which the app can exchange the code for tokens. [Authorization grants](https://developer.amazon.com/docs/login-with-amazon/authorization-grants.html)
- The documented Login with Amazon customer-profile response contains `user_id`, `email`, `name`, and `postal_code`; the documented scopes are `profile`, `profile:user_id`, and `postal_code`. The docs do not list shopping, payment, cart, or order scopes. [Customer profile](https://developer.amazon.com/docs/login-with-amazon/obtain-customer-profile.html) [JavaScript SDK scopes](https://www.developer.amazon.com/docs/login-with-amazon/javascript-sdk-reference.html)
- Creators API supports `SearchItems`, `GetItems`, `GetVariations`, and `GetBrowseNodes`. Its stated purpose is catalog data for publishers, influencers, and affiliate partners. [Creators API introduction](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction) [API reference](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference)
- Creators API supports `www.amazon.co.uk`, but requires an approved Amazon Associates account for that marketplace, a valid UK partner tag, and API access. Its OAuth client-credentials token belongs to the developer application, not an Amazon retail buyer. [Common headers and marketplaces](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/common-request-headers-and-parameters) [Registration requirements](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/onboarding/register-for-creators-api) [Authentication](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/get-started/using-curl)
- Product Advertising API 5 is also an Associate product-discovery API. Amazon’s UK Associates help says it provides programmatic product selection and discovery, requires an Associates account and PA-API application, and is available in the UK. [UK Associates tools](https://affiliate-program.amazon.co.uk/welcome/topic/tools) [PA-API requirements](https://affiliate-program.amazon.co.uk/help/node/topic/GVJ2BJP35457CLML) [PA-API marketplace availability](https://affiliate-program.amazon.co.uk/help/node/topic/GUVFJTV7MGMMNY94)
- The current Creators API documentation describes a migration from PA-API and has a PA-API deprecation notice in its documentation navigation. Prefer Creators API if affiliate catalog access is useful; neither API’s published operation list includes checkout or buyer order retrieval. [Creators API introduction](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction)

### Inferences

- Giving an agent an Amazon email and password does not grant an official machine-to-machine retail purchasing interface. An agent would need to use Amazon’s normal web sign-in and checkout flow, with any Amazon challenge or consent step completed there.
- Creators API can provide a separate, official catalog-search layer, but it cannot form the purchasing path for a normal retail account.

### Gaps

- Amazon does not publish a retail-buyer API catalogue page that explicitly says “no checkout API exists.” This conclusion is based on the documented Login with Amazon scopes and the published operations of Amazon’s buyer-adjacent APIs.

## Does Amazon Business provide an API-first UK buying path, and what does it require?

### Takeaway

Yes. Amazon Business offers a UK-supported Product Search API plus Ordering API. This is the official API-first option, but it requires Amazon Business partner onboarding, approved roles, an Amazon Business customer account with a configured buying group and stored payment method, and browser-based OAuth authorization by that business customer.

### Cited Findings

- Product Search API (also called Integrated Search) searches the Amazon Business catalog and has operations for keyword/identifier search, product lookup, offer search, bulk ASIN lookup, and bulk offer lookup. It is available in the EU region for UK, DE, FR, IT, ES, and IN. [Product Search API overview](https://docs.business.amazon.com/docs/product-search-api-overview)
- Product Search requires the `Business Product Catalog` role. Its product API reference requires the requesting business user’s email in `x-amz-user-email`; it searches the business catalog and provides offer data. [Amazon Business API roles](https://docs.business.amazon.com/docs/amazon-business-roles) [Product Search reference](https://docs.business.amazon.com/docs/product-search-api-v1-reference)
- Ordering API has two documented operations: `POST /ordering/2022-10-30/orders` (`placeOrder`) and `GET /ordering/2022-10-30/orders/{externalId}` (`orderDetails`). It is available in the EU region for the UK and other listed EU marketplaces. [Ordering API overview](https://docs.business.amazon.com/docs/ordering-api)
- `placeOrder` requires a unique external ID, line items, customer-controlled attributes, and expectations. Required order attributes include region, a stored payment-method reference, buying-group reference, buyer email, shipping address, product ASIN, and purchase-order number; Amazon strongly recommends an offer ID. [Placing an order](https://docs.business.amazon.com/docs/placing-an-order)
- Ordering API places only when configured expectations and safeguards permit it. Safeguards can reject an order when price, subtotal, or total falls outside the business customer’s configured tolerance. [Ordering API safeguards](https://docs.business.amazon.com/docs/ordering-api) [Using order safeguards](https://docs.business.amazon.com/docs/using-order-safeguards)
- `orderDetails` returns item, price, status, and shipping information. It requires the order external ID and `x-amz-user-email`; the requesting email must have view-order permission in the relevant business group. SNS updates are optional. [Retrieving order status](https://docs.business.amazon.com/docs/retrieving-order-status)
- Amazon Business authenticates a third-party app through an OAuth flow based on Login with Amazon. A business customer signs in on Amazon Business and consents; the authorization code becomes a long-lived refresh token. [Website authorization workflow](https://docs.business.amazon.com/docs/website-authorization-workflow)
- The developer must register, create an app client, and receive access and refresh tokens. The customer onboarding flow requires an Amazon Business account, group, purchasing-system group identifier, purchasing preference/safeguards, payment method, active mode, and a user in the group. The developer onboarding documentation says Amazon Business works with the partner during onboarding. [Product Search onboarding](https://docs.business.amazon.com/docs/product-search-api-overview) [Ordering API onboarding](https://docs.business.amazon.com/docs/ordering-api)
- The `AmazonBusinessOrderPlacement` role is required for Ordering API and the role request is made through the Developer Registration Access Form during API onboarding. [Amazon Business API roles](https://docs.business.amazon.com/docs/amazon-business-roles)

### Inferences

- An Iterate integration can implement a fully API-first research and purchase path only when the buyer uses an Amazon Business UK account and Amazon approves the required integration roles.
- The integration should model each agent as an authorised Amazon Business group user, pass the user email plus group identity, and enforce local spend approval before `placeOrder`. It should send price/total expectations and configure Amazon safeguards to prevent unwanted substitutions or price rises.
- The Amazon Business OAuth consent flow is a supported way to connect the business account. It is not an email-and-password exchange API.

### Gaps

- Public documentation does not state whether a new research integration will be approved for every requested role, nor does it publish commercial or contractual eligibility details. These need confirmation from Amazon Business during developer onboarding.
- Public documentation does not describe an API to retrieve all historical buyer orders through Ordering API; `orderDetails` retrieves one order by external ID. Amazon Business Reporting API may meet wider reporting needs, subject to its separate role and onboarding.

## Which official Amazon APIs are adjacent but unsuitable for buyer purchasing?

### Takeaway

Selling Partner API is for sellers and vendors, not retail buyers. Login with Amazon is suitable for identity and Amazon Business uses it as part of its consent process; it is not a retail purchasing API. Creators API and PA-API are catalog/affiliate APIs, so they can support research but cannot submit orders on a buyer account.

### Cited Findings

- SP-API onboarding defines a selling partner as a business that works with Amazon as a seller or vendor, and describes automating selling operations such as order processing, shipment tracking, and payment management. [SP-API onboarding overview](https://developer-docs.amazon.com/sp-api/docs/onboarding-overview)
- SP-API’s current Orders API availability is “Sellers only”; it retrieves orders for a selling partner. [SP-API Orders API](https://developer-docs.amazon.com/sp-api/docs/orders-api?ld=ASXXSPAPIDirect&pageName=US%3ASPDS%3ASPAPI-amazon-business)
- Amazon Business API roles separately offer catalog search, ordering, reporting, reconciliation, user management, and package tracking for Amazon Business marketplaces. This is a different buyer integration product from SP-API. [Amazon Business API roles](https://docs.business.amazon.com/docs/amazon-business-roles)
- Creators API requires qualifying Associate sales and approval for access, has rate limits tied to referred sales, and expects the app to retain the returned product URLs for attribution. [Creators API introduction](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction) [Creators API rates](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/api-rates)

### Inferences

- Do not build the purchase integration on SP-API, PA-API, Creators API, or Login with Amazon alone. They do not provide the required buyer-order capability.
- The two viable implementation tracks are: (1) ordinary retail account: browser-driven Amazon checkout, after separately deciding how to use or avoid affiliate catalog APIs; or (2) Amazon Business UK account: Product Search API plus Ordering API, after Amazon approval and customer consent.

### Gaps

- I did not evaluate unofficial scraping, reverse-engineered endpoints, or third-party purchasing brokers. They are outside this official-API research scope.

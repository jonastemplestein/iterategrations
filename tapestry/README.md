# Tapestry Education Platform

Unofficial TypeScript client and CLI for the current Tapestry Android app (`com.fsf.tapestry`).
This is the school and nursery platform at `tapestryjournal.com`.

The app has two protocols: JSON API v4 for native features, and an authenticated website for
other screens. The client supports both with `fetch`. It has no runtime dependencies.
Node 22+ and Bun can run the CLI.

The client is read-only by default. Reads do not call the separate notification or message
read-state endpoints. Write methods need `{ allowWrites: true }`; CLI writes need `--write`.
No write retries run automatically.

## Use from source

```sh
pnpm --filter iterate-tapestry build
node tapestry/dist/cli.js help
```

Inject `TAPESTRY_EMAIL` and `TAPESTRY_PASSWORD` through the environment, for example with
1Password `op run`. Do not put passwords in command arguments or source files.

```sh
node tapestry/dist/cli.js login
node tapestry/dist/cli.js select SCHOOL_ID
node tapestry/dist/cli.js children
node tapestry/dist/cli.js observations --limit 10
node tapestry/dist/cli.js conversations
node tapestry/dist/cli.js messages CONVERSATION_ID
node tapestry/dist/cli.js care-diary 2026-10-09
```

Login lists the available schools. Select one before reading its data. The CLI saves account
and school tokens in `$XDG_CONFIG_HOME/tapestry/session.json` (default
`~/.config/tapestry/session.json`) with mode `0600`. It does not save the password. It preserves
the device ID and saves rotated refresh tokens after commands. `logout` removes this local file.

CI publishes the package through pkg.pr.new. Pin an actual published commit:

```sh
pnpm add https://pkg.pr.new/jonastemplestein/iterategrations/iterate-tapestry@COMMIT
```

## Library

```ts
import { TapestryClient } from "iterate-tapestry";

const client = new TapestryClient({ session: savedSession });
// First login: const schools = await client.login(email, password);
// Then: await client.authenticateSchool(schools[0].id);

const children = await client.getChildren();
const page = await client.getObservations({ limit: 20 });
const next = page.nextCursor
  ? await client.getObservations({ limit: 20, cursor: page.nextCursor })
  : undefined;
const conversations = await client.getConversations();
const diary = await client.getCareDiary("2026-10-09");
// diary.html contains the care diary, including any meal records the school shared.
// Persist client.getSession() after calls, including after a refresh.
```

Account login and school login use different tokens. `authenticateSchool(id)` creates the
school session. School tokens refresh before expiry; simultaneous reads share one refresh.
If the service requires a new login, `ApiError.code` contains its problem type. A school MFA
challenge retains the account token. Completing Tapestry MFA is not yet implemented.

| Area                 | Methods and return format                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Account              | `login`, `getSchools`, `authenticateSchool`, `getCurrentUser`, `getChildren` — JSON                                            |
| Observations         | `getObservations`, `observations` iterator, `getObservation`, `getObservationAuthors` — JSON                                   |
| Threads              | `getThreads` — JSON                                                                                                            |
| Notifications        | `getNotifications`, `getAnnouncements`, `getUpdateCounts`, `getNavigation` — JSON                                              |
| Messages             | `getConversations`, `getMessages`, `getMessageRecipients`, `getMessagingSettings` — JSON                                       |
| Memos and activities | `getMemos`, `getActivities` — `WebPage`                                                                                        |
| Care diary and meals | `getCareDiary(date)` — `WebPage`                                                                                               |
| Billing              | `getAccountBalances` — `WebPage`, subject to school permissions                                                                |
| Writes               | `sendMessage`, `createConversation`, `addComment`, `setLike`, `createObservation`, `updateObservation`, `markNotificationSeen` |
| Lower-level access   | `request`, `schoolRequest`, `getSchoolPage`, `getWebView`                                                                      |

A `WebPage` contains `{ html, data }`. `html` is the server-rendered page. `data` contains its
embedded JSON configuration. Memos, activities and the care diary do not expose a native
JSON list in this app. Returning the original page preserves the records and attachments
without inventing a JSON schema. Page data can contain CSRF tokens; handle it as private data.

Observation pages have `nextCursor` and `prevCursor`. The `observations()` iterator guards
against repeated cursors. Message pages have `data`, `next_cursor` and `prev_cursor`.
The client keeps the server's message order and does not mark messages as read.

`request("observations/list", { query: { perPage: 20 } })` calls `/api/4/…`.
`schoolRequest("messaging/conversations", { method: "POST", body: { userId } })` calls a
school-scoped website endpoint. Website calls use the app's WebView user-agent, cookies,
CSRF token and `X-TAPESTRY-VERSION: 3`. The client loads this context once per instance.
It rejects external URLs, path traversal and redirects. A CSRF failure throws without retry.

Observation writes accept the app's full JSON body so callers can retain assessments, media
references and links. Their payload shape is recorded in the protocol notes. Uploading new
media is not yet implemented. These write paths have no live mutation tests.

## Verification and limits

Live read checks passed for login, school selection, children, observations and pagination,
observation details, notifications, conversations, messages, recipients, memos, activities and
care diary pages. The tested account receives HTTP 403 from the account-balances page; the
client reports that restriction. Other schools can enable different features.

The care diary can report meals already recorded by the nursery. No parent meal-planning or
meal-order endpoint was identified. The client does not change school settings or permissions.

See [the protocol notes](../research/school-apps/README.md) for evidence and APK hashes.
Private protocols can change. Keep sessions and child data outside source control.

```sh
pnpm --filter iterate-tapestry test
```

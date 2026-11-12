# Seesaw

Unofficial TypeScript client and CLI for Seesaw parent accounts. It follows the Android app's
REST and GraphQL protocols. It uses `fetch` and needs no browser or runtime dependencies.
Node 22+ and Bun can run the CLI.

The client is read-only by default. It does not clear notification counts, mark conversations
as read, or retry writes. Passwords are never saved. The CLI stores the access token in
`$XDG_CONFIG_HOME/seesaw/session.json` (default `~/.config/seesaw/session.json`) with mode `0600`.
Treat this file as a password.

## Use from source

```sh
pnpm --filter iterate-seesaw build
node seesaw/dist/cli.js help
```

Set `SEESAW_EMAIL` and `SEESAW_PASSWORD` in the process environment. Use `op run` to inject them
from your own 1Password item. Do not put passwords in command arguments or source files.

```sh
node seesaw/dist/cli.js login
node seesaw/dist/cli.js children
node seesaw/dist/cli.js journal --limit 10
node seesaw/dist/cli.js conversations
node seesaw/dist/cli.js conversations --hidden
node seesaw/dist/cli.js messages CONVERSATION_ID --limit 20
```

If login requests two-factor authentication, set `SEESAW_CODE` to the current code and repeat
`login`. `SeesawChallengeError` exposes `challenge`, `method` and `redactedEmail`. CAPTCHA
challenges require the normal Seesaw login flow; the client also accepts `SEESAW_CAPTCHA_RESPONSE`.
An existing token can be supplied through `SEESAW_ACCESS_TOKEN` and `SEESAW_PERSON_ID`.
`logout` removes the local session. It does not revoke sessions on other devices.

CI publishes this package through pkg.pr.new, like the other packages in this repo. Pin an
actual published commit:

```sh
pnpm add https://pkg.pr.new/jonastemplestein/iterategrations/iterate-seesaw@COMMIT
```

## Library

```ts
import { SeesawClient } from "iterate-seesaw";

const client = new SeesawClient({ session: savedSession });
const children = await client.getChildren();
const classes = await client.getChildClasses(children[0].person_id);
const page = await client.getJournal({ limit: 20 });
// page.items.objects contains { item, type } wrappers.
for await (const item of client.journal({ limit: 20 })) {
  // Process each journal item. Photos, documents and other media retain their app fields.
}
const conversations = await client.getConversations();
const id = conversations.edges[0].conversation.id;
const messages = await client.getMessages(id, { limit: 20 });
// Continue with messages.pageInfo.endCursor while hasNextPage is true.
```

`login(email, password, { twoFactorCode?, captchaResponse? })` returns a session.
`getSession()` returns a copy; `setSession()` restores one. Save it securely in your application.
Live reads passed for children, classes, journals, pagination, item details, dashboard,
notifications and messages, including hidden conversations. An empty default inbox can still
have hidden conversations: use `getConversations({ hidden: true })` or CLI `--hidden`.
The tested parent account receives HTTP 403 from the activity feed.

There is no confirmed refresh-token flow. Log in again when the service rejects an expired token.

| Area                  | Methods                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| Account and classes   | `getParent`, `getChildren`, `getChildClasses`, `getDashboard`                        |
| Journals              | `getJournal`, `getClassJournal`, `journal`, `getItem`                                |
| Homework / activities | `getActivities(classId, { states, startKey?, studentId? })`, `getActivity(promptId)` |
| Notifications         | `getNotifications(startKey?)`                                                        |
| Messages              | `getConversations`, `getMessages`                                                    |
| Explicit writes       | `sendMessage`, `addComment`, `setLike`                                               |
| Custom operations     | `graphql(query, variables)` and exported `OPERATIONS`                                |

Responses retain the server's fields. REST cursors are `last_key`; message cursors use
`pageInfo`. Pass cursors back unchanged. The journal iterator stops on a repeated cursor.
Activity states include `published`, `scheduled`, `archived`, `pending` and `completed`.
Schools can restrict activities to student or teacher accounts. The client uses parent login
and does not switch roles to bypass that restriction.

To use a write method, construct a separate client with `{ session, allowWrites: true }`.
CLI writes also require `--write`. These methods have mock tests; live validation uses reads
only. After a network failure, check the resulting state before resending a write.

## Evidence and limits

See [the protocol notes](../research/school-apps/README.md) for APK hashes and source locations.
The protocols are private and can change. `ApiError` exposes `status` and `code`; it omits server
error messages that may contain account data. Requests have a configurable timeout and refuse
redirects that could forward tokens.

Meal menus can appear in journal posts or message attachments. No dedicated meal-order API
was identified in the parent app. This package does not implement meal booking, account
administration, student homework submission, or media uploads.

```sh
pnpm --filter iterate-seesaw test
```

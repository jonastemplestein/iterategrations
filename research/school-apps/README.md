# School app protocols

Investigation date: 2026-10-09. These notes describe observed app behavior. They are not public
API guarantees. The client packages contain no APK files, decompiled vendor code, credentials,
sessions, school identities, or child records. Tests use synthetic fixtures.

## Artifacts

APKs and local analysis are in `~/.cache/school-apps/` on Beelink. Private account samples are in
its `private/` directory (mode `0700`; files mode `0600`). They are not test fixtures.

| Artifact       | Android package                    | Version  | Code    | SHA-256                                                            |
| -------------- | ---------------------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `seesaw.apk`   | `seesaw.shadowpuppet.co.classroom` | 10.146.0 | 1983967 | `b0129b5f62e5d1f3434a4cbc20ff28d258f8aafac00ecc7b484b7d31f86976c3` |
| `tapestry.apk` | `com.fsf.tapestry`                 | 1.0.7    | 36      | `c3160f005a9fd884ce13f604e56b0c177bd6cbd214a2323285a64f526acc4d07` |

Downloads:

- Seesaw: `https://d.apkpure.net/b/APK/seesaw.shadowpuppet.co.classroom?version=latest`.
  The response is a split package ZIP, saved as `seesaw.xapk`. `seesaw.apk` is its base APK.
- Tapestry: `https://d.apkpure.net/b/APK/com.fsf.tapestry?version=latest`.
  The response is a base APK.

These are mirror downloads. Package IDs, versions and hashes were inspected. The signing
certificates were not independently verified against Google Play. Neither APK was installed
or executed. `latest` is a moving URL; record the new hash before comparing a later download.

Official identities: [Seesaw on Google Play](https://play.google.com/store/apps/details?id=seesaw.shadowpuppet.co.classroom)
and [Tapestry Education Platform on Google Play](https://play.google.com/store/apps/details?id=com.fsf.tapestry).
The current Tapestry app replaced the older app in 2026. Do not confuse it with unrelated
products named Tapestry.

## Extraction

`jadx` 1.5.6 extracts manifests and bundled assets. Seesaw ships readable web JavaScript under
`assets/seesaw_webview/static/js/`. Tapestry ships React Native Hermes bytecode in
`assets/index.android.bundle` (bytecode version 96).

Tapestry was decoded with [P1sec/hermes-dec](https://github.com/P1sec/hermes-dec), checked out at
`~/src/github.com/P1sec/hermes-dec`. Example command from that checkout:

```sh
PYTHONPATH=src python -m hermes_dec.decompilation.hbc_decompiler \
  ~/.cache/school-apps/tapestry.bundle \
  ~/.cache/school-apps/tapestry.decompiled.js
```

`vp fmt` made the extracted JavaScript readable. Line numbers below refer to those local,
formatted files. The app's authenticated web pages then supplied public asset URLs under
`https://www.tapestryjournal.com/vite/assets/`. Those scripts were saved in `tapestry-web-js/`.
Do not copy full vendor bundles into this repo.

## Seesaw

Base REST origin: `https://app.seesaw.me`. GraphQL origin:
`https://reloaded-api.seesaw.me/ss2_gql`. The latter was confirmed against the live website.
The APK's native transport has its own rewrite behavior; posting GraphQL to the REST origin
returns HTTP 405.

REST authenticates with `Authorization: Bearer <user_token>`. Login is a URL-encoded POST to
`/api/auth/login` with `email`, `password`, `role=parent`, `classes=true`, `_release` and
`_tz_offset` (seconds east of UTC). A successful response is:

```text
{ status: "OK", response: { user_token, person: { person_id, ... }, ... } }
```

Application errors can use HTTP 200 with `status=ERROR` and `error_dict.error_code`.
Two-factor challenges use `two_factor_authentication_required`,
`two_factor_authentication_method`, and `redacted_email`. Repeat login with
`two_factor_authentication_code`. CAPTCHA uses `g_recaptcha_response`.

| Endpoint                                      | Inputs / response                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/api/person/parent/info`                     | Children in `children.objects`                                                                       |
| `/api/person/parent/child_classes`            | `child_id`; classes in `objects`                                                                     |
| `/api/person/parent/dashboard_v3`             | Parent settings and feature flags                                                                    |
| `/api/person/parent/feed`                     | `limit`, `start_key`; `items.objects` contains `{item, type}` wrappers; next cursor `items.last_key` |
| `/api/person/parent/class_feed`               | `child_id`, `class_id`, optional `folder_id`, same pagination                                        |
| `/api/item_v2`                                | `item_id`; response contains `item`                                                                  |
| `/api/prompt/feed`                            | `class_id`, comma-separated `prompt_states`, `user_id`, `start_key`; school permissions apply        |
| `/api/prompt`                                 | `prompt_id`, optional `classId`, `user_id`, `load_recurrence`                                        |
| `/api/person/parent/notifications`            | `start_key`, `clear_unread_count=false`                                                              |
| `/api/item/add_comment`                       | POST `item_id`, `comment_text`, `user_id`, optional `class_id`                                       |
| `/api/item/add_like`, `/api/item/remove_like` | POST `item_id`, `user_id`                                                                            |

Source evidence in `4176.9d10bdb8.chunk.js`: login service near line 112780; form transport
near 112930; notifications near 21425; activity feed near 105465; activity details near 105510;
likes near 62535; comments near 62610 and 114128.

Messaging uses GraphQL union results, including errors returned inside `data`. The bundled
operations are in `main.b15b829e.js` around lines 25600–26660. Conversations and messages use
connection cursors. `sendMessage` uses `conversationId`, `content`, `tempId` and
`markupType: PLAIN_TEXT`. Keep a caller-provided `tempId` stable when reconciling a failed send.
The client never retries a send automatically.

Live checks: email/password login, email two-factor login, parent/children, three classes,
dashboard, journal and second page, class journal, item details, notifications and conversation
query. The default conversation list was empty; a follow-up read with `isHidden=true` found
parent conversations and confirmed live message retrieval. Message reads also have mock tests. The parent account receives HTTP 403 from the activities feed. No roles or permissions
were changed. No school messages, comments or likes were sent.

## Tapestry

Base origin: `https://www.tapestryjournal.com`. Native JSON endpoints are under `/api/4/`.
Headers: `X-Api-Key`, persistent `X-Device-Id`, and user-agent suffix
`android TapestryApp/1.0.7`.

Authentication is two-stage:

1. POST `authenticate` with `{email, password}`. Save `credentials.access` as the account token.
2. GET `school-list` with that token. The response is `{schools: [...]}`.
3. POST `authenticate-school` with `{id, appVersion: "1.0.7"}` and the account token.
   The response contains `{school, user, credentials}`. Save the school token separately.
4. POST `refresh-authenticate-school` with `{refresh}` and the old school access token.
   `credentials.expiry` is a lifetime in seconds. The app refreshes 60 seconds before expiry.
   The refresh response includes only `school.id`; preserve the existing school metadata,
   including `furlSlug`, when replacing credentials.

Evidence in `tapestry.decompiled.js`: auth service around 362850–363450; axios interceptor
around 375430; expiry around 381817; refresh around 550950; default production origin around 952657. School MFA uses a `multi-factor-authentication-required` problem and a `process-code`
endpoint. The latter is not implemented because its request body was not confirmed.

| Native endpoint                    | Shape / use                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `users/currentUser`                | `{user}`                                                                                                                       |
| `children/list`                    | Child array                                                                                                                    |
| `polling/list`                     | Unread counts                                                                                                                  |
| `observations/list`                | `perPage`, `cursor`, `search`, `hashtag`, `children.child_id`, `observations.author`; `{observations, nextCursor, prevCursor}` |
| `observations/get/{id}`            | Observation, children, comments, media, documents, assessments, capabilities                                                   |
| `observations/list-authors`        | Author information                                                                                                             |
| `pages/threads-list`               | `perPage`, `cursor`, `search`, `children.child_id`, `authorId`; pages                                                          |
| `notifications/list`               | `page`, `perPage`; `{notifications}`                                                                                           |
| `announcements/list-announcements` | `position=dropdown` or `toast`, `onlyUnseen=0` or `1`                                                                          |
| `navigation`                       | Feature navigation                                                                                                             |
| `notifications/mark-seen`          | Explicit POST `{notificationId}`                                                                                               |
| `comment/add-comment`              | Explicit POST `{pageId, comment}`                                                                                              |
| `pages/set-likes`                  | Explicit POST `{pageId, like}`                                                                                                 |

Web source: `Queries-CzivKnIp.js` and `ViewObservationPage-Bc364Ypx.js`. The observation-list
parser confirms the `observations` array. Message pagination uses different field names.

Observation create/update endpoints accept JSON with `uploadKey`, `title`, `notes`, `childIds`,
`date`, `assessments`, `flags`, `mediaItems` and, for published submissions, `status`. Updates
include `id`. Draft endpoints end in `create-draft` or `update-draft`. Native payload construction
is around 558950–559227. Relative accounts omit staff-only `additionalInformation`. Callers
must preserve media references and assessment structures. No new-media upload flow or status
transition has been tested live.

### Embedded website

The app loads `/s/{school.furlSlug}/v3/…` with `X-Api-Key` and `X-Device-Id`. Its user-agent
suffix is **`android TapestryAppWebView/1.0.7`**. With the native API user-agent, the same URL
redirects to the school root. This distinction is required.

The observations shell provides a `tapestry_session` cookie and an HTML-escaped JSON object
in a hidden div with `data-modern-javascript-function-id="tapestry3"`. That object includes
`csrfToken`, `authenticatedUser` and `routeMappings`. Subsequent school requests use the
cookie, `X-CSRF-TOKEN` and `X-TAPESTRY-VERSION: 3`. CSRF tokens can rotate in response headers.
A missing cookie can return **HTTP 200 with `{success:0, code:"CSRF", newToken:…}`**. Treat this
as failure, not a successful send. The client updates the token and throws without retrying.

Messaging endpoints under `/s/{slug}/messaging/`:

| Path                  | Method                            | Body                               |
| --------------------- | --------------------------------- | ---------------------------------- |
| `frontend-data`       | GET                               | Settings and allowed users         |
| `conversations`       | POST (read)                       | `{userId}`                         |
| `messages`            | POST (read)                       | `{userId, conversationId, cursor}` |
| `users`               | POST (read)                       | `{}`                               |
| `send-message`        | POST (write)                      | `{conversationId, messageContent}` |
| `create-conversation` | POST (write)                      | `{userId, otherParticipant}`       |
| `mark-read`           | POST (write; not called by reads) | `{conversationId, messageId}`      |

The message response contains `data`, `next_cursor`, `prev_cursor` and pagination URLs. Read
semantics and bodies come from `Index-BgwB0K3p.js`, class near line 23690. Route templates come
from the authenticated shell; `RoutingService-Cf08uLDu.js` expands them.

Memos (`memos`), activities (`activities`) and care diary (`care-diary/relative/YYYY-MM-DD`)
remain server-rendered HTML. The care diary's date switch reads
`care-diary/relative/get-child-data?date=YYYY-MM-DD` and also returns HTML. Source:
`main.09f6d7d69264cec87297d2d34f1d4b6e.js`, `Olj.CareDiary.RelativeIndex`, around line 9905.
The client returns the original HTML and embedded JSON instead of guessing list endpoints.

Live checks passed for both auth stages, children, observations and second page, details,
notifications, conversations, messages, recipients, memos, activities and care diary. The
account-balances website route returned 403. No messages, edits, likes, mark-read calls,
medication approvals or payments were made.

## Scope of “all”

Both clients expose the confirmed parent-facing features and lower-level protocol access.
They do not claim complete parity with teacher/admin tools or every app screen. Parent activity
permissions, Tapestry school MFA, new-media uploads, student submissions, billing permissions
and a dedicated meal-order provider remain separate limits. A meal menu attached to a post is
available through that post; a nursery's recorded meals are in the care diary. No standalone
parent meal-order workflow was found in either app.

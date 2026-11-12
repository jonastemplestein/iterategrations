#!/usr/bin/env node
import { parseArgs } from "node:util";
import { rm } from "node:fs/promises";
import { TapestryClient, type TapestrySession, type WebView } from "./index.js";
import { env, loadSession, saveSession, sessionPath } from "./session-file.js";

const HELP = `Tapestry Education Platform API
  tapestry login                 Use TAPESTRY_EMAIL and TAPESTRY_PASSWORD
  tapestry logout                Remove the local session
  tapestry schools
  tapestry select <school-id>
  tapestry me
  tapestry children
  tapestry observations          --limit 20 --cursor KEY --search TEXT
  tapestry observation <id>
  tapestry announcements
  tapestry notifications         --page 1 --limit 20
  tapestry conversations
  tapestry messages <id>         --cursor KEY
  tapestry recipients
  tapestry memos
  tapestry activities
  tapestry care-diary YYYY-MM-DD
  tapestry balances
  tapestry send <id> <text>       --write
  tapestry comment <id> <text>    --write
  tapestry like <id>              --write
  tapestry unlike <id>            --write
  tapestry authors
  tapestry updates
  tapestry seen <notification-id> --write
  tapestry web <view>             Return the embedded website's HTML

Views: observations, memos, activities, messaging, notifications, care-diary.
Select a school after login. Tokens refresh before expiry. Passwords are not saved.
`;

async function main(): Promise<void> {
  const {
    positionals: [command = "help", argument, content],
    values,
  } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      cursor: { type: "string" },
      search: { type: "string" },
      page: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  if (command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (
    ![
      "login",
      "logout",
      "schools",
      "select",
      "me",
      "children",
      "observation",
      "observations",
      "notifications",
      "announcements",
      "conversations",
      "messages",
      "recipients",
      "memos",
      "activities",
      "care-diary",
      "balances",
      "send",
      "comment",
      "like",
      "unlike",
      "authors",
      "updates",
      "seen",
      "web",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}. Run tapestry help`);
  const path = sessionPath("tapestry");
  if (command === "logout") {
    await rm(path, { force: true });
    console.log("Local session removed");
    return;
  }
  const client = new TapestryClient({
    allowWrites: values.write,
    session: await loadSession<TapestrySession>(path),
  });
  let result: unknown;
  try {
    switch (command) {
      case "login":
        result = await client.login(env("TAPESTRY_EMAIL"), env("TAPESTRY_PASSWORD"));
        break;
      case "schools":
        result = await client.getSchools();
        break;
      case "select": {
        const auth = await client.authenticateSchool(Number(argument));
        result = { school: auth.school };
        break;
      }
      case "me":
        result = await client.getCurrentUser();
        break;
      case "children":
        result = await client.getChildren();
        break;
      case "observations":
        result = await client.getObservations({
          limit: values.limit === undefined ? undefined : Number(values.limit),
          cursor: values.cursor,
          search: values.search,
        });
        break;
      case "announcements":
        result = await client.getAnnouncements();
        break;
      case "notifications":
        result = await client.getNotifications(
          Number(values.page ?? 1),
          Number(values.limit ?? 20),
        );
        break;
      case "conversations":
        result = await client.getConversations();
        break;
      case "messages":
        result = await client.getMessages(Number(argument), values.cursor);
        break;
      case "recipients":
        result = await client.getMessageRecipients();
        break;
      case "memos":
        result = await client.getMemos();
        break;
      case "activities":
        result = await client.getActivities();
        break;
      case "care-diary":
        result = await client.getCareDiary(argument);
        break;
      case "balances":
        result = await client.getAccountBalances();
        break;
      case "send":
        result = await client.sendMessage(Number(argument), content);
        break;
      case "comment":
        result = await client.addComment(Number(argument), content);
        break;
      case "like":
      case "unlike":
        result = await client.setLike(Number(argument), command === "like");
        break;
      case "observation":
        result = await client.getObservation(Number(argument));
        break;
      case "authors":
        result = await client.getObservationAuthors();
        break;
      case "updates":
        result = await client.getUpdateCounts();
        break;
      case "seen":
        result = await client.markNotificationSeen(Number(argument));
        break;
      case "web": {
        const views = [
          "observations",
          "memos",
          "activities",
          "messaging",
          "notifications",
          "announcements",
          "care-diary",
        ];
        if (!views.includes(argument)) throw new Error(`Choose a view: ${views.join(", ")}`);
        result = await client.getWebView(argument as WebView);
        break;
      }
    }
  } finally {
    // Persist rotated refresh tokens, including a login that stops at a school MFA challenge.
    const session = client.getSession();
    if (session.userAccessToken || session.selectedSchool) await saveSession(path, session);
  }
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Tapestry command failed");
  process.exitCode = 1;
});

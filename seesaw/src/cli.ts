#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { SeesawClient, type SeesawSession } from "./index.js";
import { env, loadSession, saveSession, sessionPath } from "./session-file.js";

const HELP = `Seesaw parent API
  seesaw login                       Use SEESAW_EMAIL and SEESAW_PASSWORD
  seesaw logout                      Remove the local session
  seesaw children
  seesaw classes <child-id>
  seesaw dashboard
  seesaw journal [child-id class-id]  --limit 8 --cursor KEY
  seesaw item <item-id>
  seesaw activities <class-id> --states published
  seesaw activity <prompt-id>
  seesaw comment <item-id> <text>     --write
  seesaw like <item-id>               --write
  seesaw unlike <item-id>             --write
  seesaw notifications               --cursor KEY
  seesaw conversations               --cursor KEY --search TEXT --hidden
  seesaw messages <conversation-id>  --limit 20 --cursor KEY
  seesaw send <conversation-id> <text> --write

Login challenges: set SEESAW_CODE or SEESAW_CAPTCHA_RESPONSE, then repeat login.
Reads return JSON. Sending is explicit and is never retried automatically.
`;

async function main(): Promise<void> {
  const {
    positionals: [command = "help", ...args],
    values,
  } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      cursor: { type: "string" },
      search: { type: "string" },
      states: { type: "string" },
      write: { type: "boolean", default: false },
      hidden: { type: "boolean", default: false },
    },
  });
  if (command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const commands = [
    "login",
    "logout",
    "children",
    "classes",
    "dashboard",
    "journal",
    "item",
    "activities",
    "activity",
    "comment",
    "like",
    "unlike",
    "notifications",
    "conversations",
    "messages",
    "send",
  ];
  if (!commands.includes(command)) throw new Error(`Unknown command: ${command}. Run seesaw help`);
  const path = sessionPath("seesaw");
  if (command === "logout") {
    await rm(path, { force: true });
    console.log("Local session removed");
    return;
  }
  const client = new SeesawClient({
    allowWrites: values.write,
    session: process.env.SEESAW_ACCESS_TOKEN
      ? { accessToken: process.env.SEESAW_ACCESS_TOKEN, personId: process.env.SEESAW_PERSON_ID }
      : await loadSession<SeesawSession>(path),
  });
  if (command === "login") {
    await client.login(env("SEESAW_EMAIL"), env("SEESAW_PASSWORD"), {
      twoFactorCode: process.env.SEESAW_CODE,
      captchaResponse: process.env.SEESAW_CAPTCHA_RESPONSE,
    });
    await saveSession(path, client.getSession());
    console.log("Seesaw session saved");
    return;
  }
  const arg = (n: number): string => {
    if (!args[n]) throw new Error(`Missing argument ${n + 1}. Run seesaw help`);
    return args[n];
  };
  const options = {
    startKey: values.cursor,
    limit: values.limit === undefined ? undefined : Number(values.limit),
  };
  let result: unknown;
  switch (command) {
    case "children":
      result = await client.getChildren();
      break;
    case "classes":
      result = await client.getChildClasses(arg(0));
      break;
    case "dashboard":
      result = await client.getDashboard();
      break;
    case "journal":
      result = args.length
        ? await client.getClassJournal(arg(0), arg(1), options)
        : await client.getJournal(options);
      break;
    case "item":
      result = await client.getItem(arg(0));
      break;
    case "activity":
      result = await client.getActivity(arg(0));
      break;
    case "comment":
      result = await client.addComment(arg(0), arg(1));
      break;
    case "like":
    case "unlike":
      result = await client.setLike(arg(0), command === "like");
      break;
    case "activities":
      result = await client.getActivities(arg(0), {
        states: (values.states || "published").split(","),
        startKey: values.cursor,
      });
      break;
    case "notifications":
      result = await client.getNotifications(values.cursor);
      break;
    case "conversations":
      result = await client.getConversations({
        cursor: values.cursor,
        searchText: values.search,
        hidden: values.hidden,
      });
      break;
    case "messages":
      result = await client.getMessages(arg(0), { cursor: values.cursor, limit: options.limit });
      break;
    case "send":
      result = await client.sendMessage(arg(0), arg(1));
      break;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Seesaw command failed");
  process.exitCode = 1;
});

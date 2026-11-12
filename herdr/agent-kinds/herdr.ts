// agent-kinds/herdr.ts — CODING AGENTS A PERSON STARTED BY HAND IN A HERDR PANE (Claude Code,
// Codex, opencode, …) AS AGENTS OF THE MIND. Copy this file to a mind's config repo as
// `agent-kinds/herdr.ts` and name it in worker.ts's `agentKinds`; this one (iterategrations
// herdr/) is the source of truth. It has no imports: a mind's worker strips its types and loads it
// as it is, and so does the Agents app's frame.
//
// The Herdr bridge (../src/herdr.ts) lends a computer's Herdr to the mind and lands its events on
// `/integrations/herdr/<computer>`. This kind reads those and keeps one agent for each pane that
// runs a coding agent, at `/agents/<person>/herdr/<computer>/<pane>`. `<person>` is the member
// whose sign-in the bridge runs on (each event says who wrote it): the start of their address,
// before the `@`. So each member's agents are in a folder of their own. A bridge that runs on a
// key has no person, and its agents are at `/agents/herdr/<computer>/<pane>`, as every agent of
// this kind was before:
//
//   `herdr/snapshot` (every connection of the bridge: what is true now)
//   → each agent pane not listed as it now is gets `herdr/agent-seen` on its own context;
//     an agent listed for this computer whose pane is gone gets `herdr/agent-gone`
//   `herdr/pane_agent_detected` (an agent appears in a pane) → `herdr/agent-seen`, with what it is
//   `herdr/pane_agent_status_changed` → `herdr/agent-seen`, the status alone
//   `herdr/pane_closed`, `herdr/pane_exited`, an agent released → `herdr/agent-gone`
//
// Each agent's context has two rows that copy those two events to the catalog on `/agents`
// (`agent/listing-updated`), so the agent shows in `itx.agents.list()` and in the Agents app with
// the other agents: its computer as `host`, the pane's title, what the agent is and where it works,
// and `working`, `waiting`, `idle` or `ended`. The catalog's `lastActivityAt` is when Herdr last
// said something about it.
//
// It lists; it does not message. A person's words to such an agent reach nobody yet: the way in is
// the bridge's own call, `itx.<lend>.call("agent.prompt", { target: "<pane id>", text })`.

/** The part of a mind's root this kind uses. */
type Itx = {
  cd(path: string): { append(...events: unknown[]): Promise<unknown> };
  agents: { list(): Promise<Record<string, unknown>[]> };
};
/** Who wrote an event, as the mind stamps it: the member, or the member that code wrote it for. */
type Writer = { principal?: { email?: string } };
type Event = {
  type: string;
  path: string;
  offset: number;
  createdAt?: string;
  payload?: unknown;
  source?: Writer & { onBehalfOf?: Writer };
};

const LISTING_UPDATED = "events.iterate.com/agent/listing-updated";
const SEEN = "herdr/agent-seen";
const GONE = "herdr/agent-gone";
/** A computer's stream, as the bridge's HERDR_LOG_PATH names it. The last part goes into paths
 *  and into the catalog, and anyone who can append to the mind can write a stream's events. */
const STREAM = /^\/integrations\/herdr\/([A-Za-z0-9_-]{1,40})$/;

/** Herdr's `AgentStatus` in the catalog's words. `blocked` is an agent that waits for its person. */
const STATUS: Record<string, string> = {
  working: "working",
  blocked: "waiting",
  idle: "idle",
  done: "idle",
  unknown: "idle",
};

/** The two rows of an agent's context: its `seen` and `gone` events, copied to the catalog. A
 *  field the event does not have is left out of the copy, and the catalog keeps what it had. */
export const CATALOG_ROWS = [
  {
    name: "herdr-catalog-seen",
    consumes: [SEEN],
    afterOffset: 0,
    ordered: false,
    target: {
      path: "/agents",
      type: LISTING_UPDATED,
      payload: `{ "kind": "herdr", "host": payload.computer, "status": payload.status, "title": $substring(payload.title, 0, 120), "activity": $substring(payload.activity, 0, 300), "description": $substring(payload.description, 0, 1000) }`,
    },
  },
  {
    name: "herdr-catalog-gone",
    consumes: [GONE],
    afterOffset: 0,
    ordered: false,
    target: {
      path: "/agents",
      type: LISTING_UPDATED,
      payload: `{ "kind": "herdr", "host": payload.computer, "status": "ended", "activity": "Its pane closed" }`,
    },
  },
];

/** WHERE THE PEOPLE'S FOLDERS ARE: each member's agents are under `<PEOPLE>/<person>`. `/agents`
 *  puts a person's folder beside the kinds' folders; `/agents/by` gives the people a level of
 *  their own. */
const PEOPLE = "/agents";

/** The folder name of the member who wrote `event`: the start of their sign-in address, in lower
 *  case, with `-` for what is no letter or digit. `null` when no member wrote it (a bridge on a
 *  key, the mind's own code). */
export function personOf(event: Pick<Event, "source">): string | null {
  const email = event.source?.principal?.email || event.source?.onBehalfOf?.principal?.email || "";
  const name = email
    .split("@")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return name || null;
}

/** The agent of a pane: `<PEOPLE>/<person>/herdr/<computer>/<pane>`, or with no person
 *  `/agents/herdr/<computer>/<pane>`. A pane id (`w3:p1`) is not a path part as it is. */
export const agentPath = (computer: string, paneId: string, person?: string | null) =>
  `${person ? `${PEOPLE}/${person}` : "/agents"}/herdr/${computer}/${paneId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)}`;

export default {
  kind: "herdr",
  processEvent,
  view: ({ html, useMemo, ui }: any) =>
    function HerdrAgent(props: any) {
      const { rows, status } = useMemo(
        () => eventsToRows(props.context.events),
        [props.context.events],
      );
      const empty = html`
        <p className="py-16 text-center text-sm text-muted-foreground">
          Herdr has said nothing yet.
        </p>
      `;
      const note = html`
        <p className="py-3 text-xs text-muted-foreground">
          A person started this agent in a Herdr pane. iterate lists it and does not run it: open
          the pane to talk to it.
        </p>
      `;
      return html`
        <${ui.AgentShell} ...${props} status=${status}>
          <${ui.Feed}
            rows=${rows}
            older=${props.context.older}
            empty=${empty}
            renderRow=${(row: HerdrRow) =>
              html`<p className="py-1 text-xs text-muted-foreground">${row.text}</p>`}
            footer=${note}
          />
        </${ui.AgentShell}>
      `;
    },
};

/** One line of the agent's page: what Herdr said, and when. */
export type HerdrRow = { key: string; offset: number; text: string };

/** What Herdr said about the agent, oldest first, and what it is doing now. */
export function eventsToRows(events: readonly Event[]): {
  rows: HerdrRow[];
  status: { text: string; tone: "live" | "amber" | "muted" };
} {
  const rows: HerdrRow[] = [];
  let status: { text: string; tone: "live" | "amber" | "muted" } = { text: "Idle", tone: "muted" };
  for (const event of events) {
    if (event.type !== SEEN && event.type !== GONE) continue;
    const said = record(event.payload);
    const state = event.type === GONE ? "ended" : str(said.status) || "idle";
    const at = (event.createdAt || "").slice(11, 16);
    const where = [str(said.title), str(said.activity)].filter(Boolean).join(" · ");
    rows.push({
      key: String(event.offset),
      offset: event.offset,
      text: `${at} UTC  ${state}${where ? `  ${where}` : ""}`,
    });
    const tones = { working: "live", waiting: "amber" } as const;
    status = {
      text: `${state[0]!.toUpperCase()}${state.slice(1)}`,
      tone: tones[state as keyof typeof tones] || "muted",
    };
  }
  return { rows, status };
}

/** Reads a computer's Herdr events and keeps its agents' contexts (the header says how). An event
 *  can come more than once, and in any order: each append is keyed by the event it answers. */
async function processEvent({ event, itx }: { event: Event; itx: Itx }) {
  const computer = STREAM.exec(String(event.path))?.[1];
  if (!computer || !String(event.type).startsWith("herdr/")) return;
  const data = record(record(event.payload).data);
  const key = `herdr-agent:${event.path}:${event.offset}`;
  const person = personOf(event);
  const pathOf = (paneId: string) => agentPath(computer, paneId, person);
  const see = (pane: Record<string, unknown>, more: Record<string, string>) =>
    itx.cd(pathOf(str(pane.pane_id))).append(...setupEvents(), {
      type: SEEN,
      idempotencyKey: `${key}:${str(pane.pane_id)}:seen`,
      payload: {
        computer,
        pane: str(pane.pane_id),
        status: STATUS[str(pane.agent_status)] || "idle",
        ...more,
      },
    });
  const leave = (path: string) =>
    itx.cd(path).append({
      type: GONE,
      idempotencyKey: `${key}:${path}:gone`,
      payload: { computer },
    });
  /** The agents the catalog lists for this computer that have not ended, in a person's folder or
   *  not: an agent listed before its person had a folder is this computer's too, and ends when
   *  its pane is no longer there under that path. */
  const listedHere = async () =>
    (await itx.agents.list()).filter(
      (row) =>
        str(row.path).startsWith("/agents/") &&
        str(row.path).includes(`/herdr/${computer}/`) &&
        row.status !== "ended",
    );

  if (event.type === "herdr/snapshot") {
    const panes = list(record(data.snapshot).agents)
      .map(record)
      .filter((pane) => str(pane.pane_id) && str(pane.agent));
    const listed = await listedHere();
    for (const pane of panes) {
      const now = describe(computer, pane);
      const row = listed.find((each) => each.path === pathOf(str(pane.pane_id)));
      // a snapshot comes at every connection: an agent listed as it now is gets no new event
      const same =
        row &&
        row.status === (STATUS[str(pane.agent_status)] || "idle") &&
        row.title === now.title &&
        row.activity === now.activity;
      if (!same) await see(pane, now);
    }
    const here = new Set(panes.map((pane) => pathOf(str(pane.pane_id))));
    for (const row of listed) if (!here.has(str(row.path))) await leave(str(row.path));
    return;
  }
  const paneId = str(data.pane_id);
  if (!paneId) return;
  const gone =
    event.type === "herdr/pane_closed" ||
    event.type === "herdr/pane_exited" ||
    (event.type === "herdr/pane_agent_detected" && (!str(data.agent) || data.released === true));
  if (gone) {
    // the pane's agent wherever it is listed: in this person's folder, or where it was before
    const paths = new Set([pathOf(paneId), agentPath(computer, paneId)]);
    for (const row of await listedHere()) if (paths.has(str(row.path))) await leave(str(row.path));
    return;
  }
  const said =
    event.type === "herdr/pane_agent_status_changed" || event.type === "herdr/pane_agent_detected";
  if (!said || !str(data.agent)) return;
  // An agent that appears in a pane says what it is, and no more: a pane's title and folder come
  // with the next snapshot. A status alone changes the status.
  await see(data, event.type === "herdr/pane_agent_detected" ? describe(computer, data) : {});
}

/** What a list shows of an agent pane besides its status: the pane's title, and one line and a
 *  few sentences of what runs there. */
function describe(computer: string, pane: Record<string, unknown>) {
  const agent = str(pane.agent);
  const cwd = str(pane.cwd) || str(pane.foreground_cwd);
  const folder = cwd.split("/").filter(Boolean).at(-1) || cwd;
  const session = str(record(pane.agent_session).value);
  return {
    title: (str(pane.terminal_title_stripped) || `${agent} in ${folder || "a pane"}`).slice(0, 120),
    activity: `${agent}${folder ? ` in ${folder}` : ""}`,
    description:
      `${agent} in the Herdr pane ${str(pane.pane_id)} on ${computer}${cwd ? `, in ${cwd}` : ""}. A person started it by hand; iterate lists it and does not run it.${session ? ` Its session is ${session}.` : ""}`.slice(
        0,
        1000,
      ),
  };
}

/** The `subscription-configured` events that give an agent's context its two rows. Each key
 *  carries a hash of its row, so setting up again appends nothing. */
export function setupEvents() {
  return CATALOG_ROWS.map((row) => ({
    type: "events.iterate.com/itx/subscription-configured",
    idempotencyKey: `herdr-agent/row:${row.name}:${fnv1a(JSON.stringify(row))}`,
    payload: row,
  }));
}

/** A short hash of a string (FNV-1a, 32 bits): a key only needs to change when its row does. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

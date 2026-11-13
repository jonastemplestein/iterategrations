// pretend-mind.ts — the pretend mind and the wait that calls.test.ts and lines.test.ts share.

export type Appended = { path: string; type: string; payload: Record<string, any> };

/** Answers what `look` finds, looking every 10 ms for `ms` (5 s). */
export async function until<T>(
  what: string,
  look: () => T | undefined | false,
  ms = 5000,
): Promise<T> {
  for (let waited = 0; waited < ms; waited += 10) {
    const found = look();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A mind whose voice app provisions devices and accepts every press a moment after it, and
 *  whose appends, kv and agent messages are kept; `whatsapp` is what itx.whatsappCalls.status()
 *  answers. */
export function pretendMind() {
  const listeners = new Map<string, (events: unknown[]) => void>();
  const mind = {
    /** Deliver events to the subscription on `path`, as the platform would. */
    say: (path: string, events: unknown[]) => listeners.get(path)?.(events),
    subscribed: [] as { path: string; name?: string }[],
    /** Each `readEvents(afterOffset)` on a path: what a moved device reads of the gap. */
    reads: [] as { path: string; afterOffset?: number }[],
    /** Each `waitForEvent` on a path, open until a test answers it or lets it time out. */
    waits: [] as {
      path: string;
      filter: Record<string, unknown>;
      answer(): void;
      timeOut(): void;
    }[],
    events: [] as Appended[],
    provisioned: [] as string[],
    messages: [] as { to: string; text: string }[],
    notes: new Map<string, string>(),
    whatsapp: null as null | { with: string },
    itx: {
      whatsappCalls: { status: async () => mind.whatsapp },
      kv: {
        get: async (key: string) => mind.notes.get(key) ?? null,
        put: async (key: string, value: string) => void mind.notes.set(key, value),
        delete: async (key: string) => void mind.notes.delete(key),
      },
      voice: {
        ensureVoiceDevice: async ({ client }: { client: string }) => {
          mind.provisioned.push(client);
          return { path: `/voice/${client}`, agentPath: `/agents/voice/${client}` };
        },
      },
      cd: (path: string) => ({
        append: async (event: { type: string; payload: Record<string, any> }) => {
          mind.events.push({ path, type: event.type, payload: event.payload });
          const { activation } = event.payload;
          // the relay accepts a press, and a call's end comes back through the subscription
          if (event.type === "events.iterate.com/voice-agent/call-started")
            setTimeout(
              () =>
                listeners.get(path)?.([
                  {
                    type: "events.iterate.com/voice-agent/conversation-accepted",
                    payload: {
                      activation,
                      pressToDialMs: 1,
                      handshakeTookMs: 1,
                      upgradeTookMs: 1,
                      heldMs: 0,
                    },
                  },
                ]),
              30,
            );
          if (event.type === "events.iterate.com/voice-agent/call-ended")
            listeners.get(path)?.([event]);
          return {};
        },
        appendOffsets: async (event: { type: string; payload: Record<string, any> }) => {
          mind.events.push({ path, type: event.type, payload: event.payload });
          return [0];
        },
        waitForEvent: (filter: Record<string, unknown>) =>
          new Promise((resolve, reject) =>
            mind.waits.push({
              path,
              filter,
              answer: () => resolve({}),
              timeOut: () => reject(new Error("WAIT_TIMEOUT")),
            }),
          ),
        readEvents: async (afterOffset?: number) => {
          mind.reads.push({ path, afterOffset });
          return { events: [], scannedThroughOffset: afterOffset ?? 0, atHead: true };
        },
        subscribe: async ({
          target,
          name,
        }: {
          target: (events: unknown[]) => void;
          name?: string;
        }) => {
          mind.subscribed.push({ path, name });
          listeners.set(path, target);
          return { [Symbol.dispose]() {} };
        },
      }),
      agents: {
        get: (to: string) => ({
          message: async (text: string) => void mind.messages.push({ to, text }),
        }),
      },
    },
  };
  return mind;
}

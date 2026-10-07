# Adding a package to a project

The recipes for `pebble/`, `waitrose/`, `monzo/`, `jmap/`, `telegram/`, `chatgpt/` and `github/` all
end the same way: the package goes into the project's config repo (`/repos/config`), as a dependency
and as one element of the `integrations` array in `worker.ts`. This is the one script that does it,
so a recipe gives only its own values.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you).

## What it does

1. Asks pkg.pr.new for the newest `main` build of the package. The loader only takes a pkg.pr.new
   package at a full commit, so it pins that commit.
2. Reads the tip of `/repos/config`, then adds the dependency to `package.json`, the import and the
   recipe's element to the `integrations` array of `worker.ts`, and any class member or new files
   the recipe names. The array is `const integrations: Integration[] = [telegram()];`: the worker
   hands each element the requests on its routing slug and every event, so nothing else changes.
3. **Probes** the result before anything is committed: it loads the whole patched repo as a worker and
   makes one request. A published commit whose worker fails takes every host of the project down.
4. Commits once, with `parent` set to the tip it read (so it is refused if someone committed meanwhile,
   and you run it again), and waits for the platform's answer: `project/worker-updated`, or
   `project/worker-update-failed`, in which case the commit is not live.

A `worker.ts` from before the array (the default template's, until October 2026) gets it: the
`Integration` type in its `iterate/sdk` import, the array before `export default class`, the
dispatch at the top of `fetch(request)` and the packages' hooks at the top of `processEvent`, each in
a block of its own so its names never meet the worker's. The template runs the hooks after the
project's own cases; an older worker's cases `return`, which would skip them, so there they run
first. The order is a project's choice.

It is safe to run twice. A package already in `package.json` gets the newer pin. A `worker.ts` whose
array already lists the package is left as it is. One that imports the package the way its recipe
used to (an import, and a branch in `fetch`) is refused, with what to take out: the package no longer
has those exports. A file the recipe adds is never overwritten. A name a worker may have already
comes with an alias (`newWorkersRpcResponse as iterateRpcResponse`), so an import is never declared
twice. Set `DRY = true` to see what it would change and commit nothing.

## The script

Replace the first block with the values a recipe gives (`PACKAGE`, `IMPORT`, `ELEMENT`, `MEMBER`,
`FILES`). Block 1b is yours: your name, and whether to try it first.

```js
async (itx) => {
  // ── 1. This recipe's values ──────────────────────────────────────────────
  const PACKAGE = "iterate-telegram";
  const IMPORT = 'import { telegram } from "iterate-telegram";'; // one import per line
  const ELEMENT = "telegram()"; // its element of worker.ts's `integrations` array
  const MEMBER = ""; // goes at the top of the worker's class (a method agents call); "" for none
  const FILES = {}; // new files: { "mail.ts": "…" }

  // ── 1b. Yours ────────────────────────────────────────────────────────────
  const VIA = "Claude Code"; // your name, for the commit message
  const DRY = false; // true: show what would change, commit nothing

  // ── 2. The newest main of iterategrations, as the full commit the loader needs ──
  const head = await itx.fetch(
    new Request(`https://pkg.pr.new/jonastemplestein/iterategrations/${PACKAGE}@main`, {
      method: "HEAD",
    }),
  );
  const sha = head.headers.get("x-commit-key")?.split(":").at(-1);
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`pkg.pr.new has no build of ${PACKAGE}`);

  // ── 3. Read the tip, then change package.json, worker.ts and the new files ──
  const repo = itx.repos.get("/repos/config");
  const tip = await repo.tip();
  const read = (path) => repo.readFile(path, { commitOid: tip });
  const pkg = JSON.parse(await read("package.json"));
  pkg.dependencies = {
    ...pkg.dependencies,
    [PACKAGE]: `https://pkg.pr.new/jonastemplestein/iterategrations/${PACKAGE}@${sha}`,
  };
  const changes = [{ path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" }];
  const had = new Set((await repo.listFiles()).paths);
  for (const [path, content] of Object.entries(FILES)) {
    if (had.has(path) && (await read(path)) !== content)
      throw new Error(
        `${path} is already in the repo and differs: merge by hand, never overwritten`,
      );
    if (!had.has(path)) changes.push({ path, content });
  }

  const original = await read("worker.ts");
  let worker = original;
  const note = [];
  /** `code` at the top of the block that `open` (a match ending in `{\n`) opens, indented. */
  const atTop = (open, code) => {
    const at = open.index + open[0].length;
    return worker.slice(0, at) + code.replace(/^(?=.)/gm, open[1] + "  ") + "\n" + worker.slice(at);
  };
  const ARRAY = /const integrations\s*:\s*Integration\[\]\s*=\s*\[([\s\S]*?)\];/;
  const callee = ELEMENT.slice(0, ELEMENT.indexOf("(")).trim(); // `telegram` for `telegram()`
  const listed = ARRAY.exec(worker);
  if (listed && new RegExp(`\\b${callee}\\s*\\(`).test(listed[1])) {
    note.push(`worker.ts already lists ${callee}(…): left as it is`);
  } else {
    if (worker.includes(`from "${PACKAGE}"`))
      throw new Error(
        `worker.ts imports ${PACKAGE} the way its recipe used to: take out that import and the branch ` +
          `in fetch that uses it (the package no longer exports it), then run this again`,
      );
    if (!listed) {
      // A worker from before the array: the type, the array, the dispatch and the hooks
      if (/\b(?:const|let|var)\s+integrations\b/.test(worker))
        throw new Error("worker.ts declares `integrations` in a shape this script does not know");
      const sdk = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"iterate\/sdk";?/.exec(worker);
      const cls = /\nexport default class [^{]*\{\n/.exec(worker);
      if (!sdk || !cls) throw new Error("worker.ts is no IterateConfigEntrypoint: add it by hand");
      if (!/\bIntegration\b/.test(sdk[2])) {
        const names = sdk[2]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        names.push(sdk[1] ? "Integration" : "type Integration");
        const list = sdk[2].includes("\n")
          ? `{\n${names.map((name) => `  ${name},`).join("\n")}\n}`
          : `{ ${names.join(", ")} }`;
        worker = worker.replace(sdk[0], () => `import ${sdk[1] ?? ""}${list} from "iterate/sdk";`);
      }
      const fetchOpen = /\n([ \t]*)(?:async\s+)?fetch\s*\(\s*request\b[^)]*\)\s*(?::[^{]+)?\{\n/;
      const eventOpen = /\n([ \t]*)async\s+processEvent\s*\(([^)]*)\)\s*(?::[^{]+)?\{\n/;
      const event = eventOpen.exec(worker);
      // the hooks are handed what processEvent was: `{ event, itx }`, or its one parameter
      const args = !event
        ? null
        : /^\s*\{\s*(?:event\s*,\s*itx|itx\s*,\s*event)\s*,?\s*\}/.test(event[2])
          ? "{ event, itx }"
          : (/^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(event[2])?.[1] ?? null);
      if (!fetchOpen.test(worker) || !args)
        throw new Error(
          "worker.ts has no fetch(request), or no async processEvent({ event, itx }): add the array by hand",
        );
      worker = atTop(
        event,
        `{
  // Every package sees the event too. The template runs these after the project's own cases;
  // here they run first, since a case that returns would skip them. The order is yours.
  const hooks = await Promise.allSettled(
    integrations.map((integration) => integration.processEvent?.(${args})),
  );
  for (const hook of hooks) if (hook.status === "rejected") throw hook.reason;
}`,
      );
      worker = atTop(
        fetchOpen.exec(worker),
        `{
  // A package answers the requests on its own routing slug.
  const routingSlug = request.headers.get("x-iterate-routing-slug");
  const integration = integrations.find((candidate) => candidate.routingSlug === routingSlug);
  if (integration?.fetch) return integration.fetch(request, this);
}`,
      );
      const at = /\nexport default class [^{]*\{\n/.exec(worker).index + 1;
      worker =
        worker.slice(0, at) +
        "// The integration packages this project hosts: one element each, from its package.\n" +
        "const integrations: Integration[] = [];\n\n" +
        worker.slice(at);
    }
    for (const line of IMPORT.split("\n").reverse())
      if (line && !worker.includes(line)) worker = line + "\n" + worker;
    // the element, after the others, in the array's own layout
    const array = ARRAY.exec(worker);
    const body = array[1];
    const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? "  ";
    const next = !body.trim()
      ? ELEMENT
      : body.includes("\n")
        ? body.replace(/,?\s*$/, () => `,\n${indent}${ELEMENT},\n`)
        : body.replace(/,?\s*$/, () => `, ${ELEMENT}`);
    const end = array.index + array[0].length;
    worker = worker.slice(0, end - body.length - 2) + next + "];" + worker.slice(end);
    if (MEMBER) {
      const first = MEMBER.split("\n")
        .map((l) => l.trim())
        .find((l) => l && !/^(\/|\*)/.test(l));
      const cls = /\nexport default class [^{]*\{\n/.exec(worker);
      if (!worker.includes(first))
        worker =
          worker.slice(0, cls.index + cls[0].length) +
          MEMBER +
          "\n" +
          worker.slice(cls.index + cls[0].length);
    }
  }
  if (worker !== original) changes.push({ path: "worker.ts", content: worker });

  // ── 4. Probe: the patched repo, loaded as a worker, before anything is committed ──
  const patched = { ...(await repo.modules({ commitOid: tip })) };
  for (const { path, content } of changes) patched[path] = content;
  const probe = await itx.workers
    .get({ source: patched })
    .fetch(new Request("https://probe.invalid/"));
  if (probe.status >= 500)
    throw new Error(`the patched worker answers ${probe.status}: nothing committed`);
  if (DRY)
    return { dry: true, sha, tip, files: changes.map((c) => c.path), note, probe: probe.status };

  // ── 5. Commit once, from the tip that was read, and wait for the platform ──
  const { commitOid } = await repo.commitFiles({
    message: `Add ${PACKAGE} (iterategrations ${sha.slice(0, 7)}). Via: ${VIA}`,
    parent: tip,
    changes,
  });
  const outcome = await itx.waitForEvent({
    type: [
      "events.iterate.com/project/worker-updated",
      "events.iterate.com/project/worker-update-failed",
    ],
    payload: { commitOid },
    afterOffset: 0,
    timeoutMs: 100_000,
  });
  return { commitOid, sha, note, outcome: outcome.type, error: outcome.payload?.error }; // worker-update-failed: NOT live
};
```

The probe makes one request, to `https://probe.invalid/`, with no routing slug: your homepage answers
it, and nothing on a recipe's own host runs. If it fails, nothing was committed: read the error, fix
`worker.ts` by hand, and run the commit yourself with
`repo.commitFiles({ message, parent: tip, changes })`.

Once it is live, the platform's `project/worker-updated` runs each package's install hook, and the
project's Integrations page in the Dash shows the package's card, with a link to its page.

## By hand

Everything above is a few small edits, if you would rather make them yourself:

```sh
curl -sI https://pkg.pr.new/jonastemplestein/iterategrations/<package>@main | grep -i x-commit-key
# x-commit-key: jonastemplestein:iterategrations:<40-hex sha>
```

- `package.json`, under `dependencies`:
  `"<package>": "https://pkg.pr.new/jonastemplestein/iterategrations/<package>@<40-hex sha>"`
- `worker.ts`: the import, and the element in the `integrations` array:

  ```ts
  import { telegram } from "iterate-telegram";

  const integrations: Integration[] = [telegram()];
  ```

  A worker from before the array also needs `type Integration` in its `iterate/sdk` import, and the
  two places the default template hands each package its requests and events:

  ```ts
  // at the top of fetch(request): a package answers the requests on its own routing slug
  const routingSlug = request.headers.get("x-iterate-routing-slug");
  const integration = integrations.find((candidate) => candidate.routingSlug === routingSlug);
  if (integration?.fetch) return integration.fetch(request, this);

  // in processEvent({ event, itx }), where every event passes
  const hooks = await Promise.allSettled(
    integrations.map((integration) => integration.processEvent?.({ event, itx })),
  );
  for (const hook of hooks) if (hook.status === "rejected") throw hook.reason;
  ```

- Commit all of it in one `commitFiles` with `parent` set to the tip you read. A commit to `main`
  publishes.

Or copy a package's source into the repo instead (each recipe says which files). You then own the
copy, and nothing is pinned.

## Updating later

Run the script again: it pins the newest `main`. To stay on a build you have tested, set `sha` yourself.
A package is never on npm.

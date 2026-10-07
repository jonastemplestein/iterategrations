# Adding a package to a project

The recipes for `pebble/`, `waitrose/`, `monzo/`, `jmap/`, `telegram/` and `chatgpt/` all end the same way: the
package goes into the project's config repo (`/repos/config`), as a dependency and as a few lines in
`worker.ts`. This is the one script that does it, so a recipe gives only its own values.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you).

## What it does

1. Asks pkg.pr.new for the newest `main` build of the package. The loader only takes a pkg.pr.new
   package at a full commit, so it pins that commit.
2. Reads the tip of `/repos/config`, then adds the dependency to `package.json`, the import and the
   branch (or class member) to `worker.ts`, and any new files the recipe names.
3. **Probes** the result before anything is committed: it loads the whole patched repo as a worker and
   makes one request. A published commit whose worker fails takes every host of the project down.
4. Commits once, with `parent` set to the tip it read (so it is refused if someone committed meanwhile,
   and you run it again), and waits for the platform's answer: `project/worker-updated`, or
   `project/worker-update-failed`, in which case the commit is not live.

It is safe to run twice. A package already in `package.json` gets the newer pin. A `worker.ts` that
already imports the package, or routes the recipe's `SLUG`, is left as it is. A file the recipe adds is never overwritten.
It adds names with an alias (`IterateWaitrose`, not `Waitrose`), so an import you already have is never
declared twice. Set `DRY = true` to see what it would change and commit nothing.

## The script

Replace the first block with the values a recipe gives (`PACKAGE`, `SLUG`, `IMPORT`, `BRANCH`, `MEMBER`,
`FILES`). Block 1b is yours: your name, and whether to try it first.

```js
async (itx) => {
  // ── 1. This recipe's values ──────────────────────────────────────────────
  const PACKAGE = "iterate-telegram";
  const SLUG = "telegram"; // the routing slug `worker.ts` answers on; "" for a package with no host
  const IMPORT = 'import { serveTelegram } from "iterate-telegram";'; // one import per line
  const BRANCH = `const telegramResponse = await serveTelegram(request, {
  withItx: async <T>(call: (itx: any) => T): Promise<Awaited<T>> => {
    using itx = this.getItx();
    return await call(itx);
  },
  requireMember: (request) => this.auth.require(request),
});
if (telegramResponse) return telegramResponse;`; // goes at the top of `fetch`; "" for none
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
  if ((SLUG && worker.includes(`=== "${SLUG}"`)) || worker.includes(`from "${PACKAGE}"`)) {
    note.push(`worker.ts already uses ${PACKAGE} or answers "${SLUG}": left as it is`);
  } else {
    for (const line of IMPORT.split("\n").reverse())
      if (line && !worker.includes(line)) worker = line + "\n" + worker;
    if (BRANCH) {
      // the first line of `fetch(request…) {`, whatever its types
      const open = /\n([ \t]*)(?:async\s+)?fetch\s*\(\s*request[^)]*\)\s*(?::[^{]+)?\{\n/.exec(
        worker,
      );
      if (!open)
        throw new Error("worker.ts has no fetch(request) to add the branch to: add it by hand");
      const at = open.index + open[0].length;
      worker =
        worker.slice(0, at) + BRANCH.replace(/^(?=.)/gm, open[1] + "  ") + "\n" + worker.slice(at);
    }
    if (MEMBER) {
      const first = MEMBER.split("\n")
        .map((l) => l.trim())
        .find((l) => l && !/^(\/|\*)/.test(l));
      const cls = /\nexport default class [^{]*\{\n/.exec(worker);
      if (!cls)
        throw new Error("worker.ts has no `export default class … {`: add the member by hand");
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

## By hand

Everything above is three small edits, if you would rather make them yourself:

```sh
curl -sI https://pkg.pr.new/jonastemplestein/iterategrations/<package>@main | grep -i x-commit-key
# x-commit-key: jonastemplestein:iterategrations:<40-hex sha>
```

- `package.json`, under `dependencies`:
  `"<package>": "https://pkg.pr.new/jonastemplestein/iterategrations/<package>@<40-hex sha>"`
- `worker.ts`: the import, and the branch at the top of `fetch(request)` (`this.getItx()` is the
  project's `itx`; `using` releases it when the block ends).
- Commit all of it in one `commitFiles` with `parent` set to the tip you read. A commit to `main`
  publishes.

Or copy a package's source into the repo instead (each recipe says which files). You then own the
copy, and nothing is pinned.

## Updating later

Run the script again: it pins the newest `main`. To stay on a build you have tested, set `sha` yourself.
A package is never on npm.

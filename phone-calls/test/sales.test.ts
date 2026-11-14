import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.env.VITEST) {
  const { test } = await import("vite-plus/test");
  test("sales calls stay isolated from member agents and tools", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./sales-regression.ts", import.meta.url))],
      { timeout: 10_000 },
    );
    assert.match(stdout, /PASS: member routing, sales isolation/);
  }, 15_000);
} else {
  await import("./sales-regression.ts");
}

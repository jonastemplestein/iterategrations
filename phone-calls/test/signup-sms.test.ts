import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vite-plus/test";

test.each(["policy", "bridge"])(
  "fixed signup SMS %s boundary",
  async (kind) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL(`./signup-sms-${kind}-regression.ts`, import.meta.url))],
      { timeout: 10_000 },
    );
    assert.match(stdout, /PASS: signup SMS/);
  },
  15_000,
);

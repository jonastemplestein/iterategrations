import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function sessionPath(service: string): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), service, "session.json");
}

export async function loadSession<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read the session file; log in again");
  }
}

export async function saveSession(path: string, session: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (use 1Password op run to inject credentials)`);
  return value;
}

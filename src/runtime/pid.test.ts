import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidFile, PidFileError } from "./pid.ts";

describe("acquirePidFile", () => {
  test("allows only one concurrent acquisition", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-pid-"));
    const pidPath = join(tempDir, "agent.pid");

    try {
      const results = await Promise.allSettled([acquirePidFile(pidPath), acquirePidFile(pidPath)]);
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquirePidFile>>> => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(PidFileError);
      expect(String(rejected[0]?.reason)).toContain(`Daemon already running with PID ${process.pid}.`);
      expect(await readFile(pidPath, "utf8")).toBe(`${process.pid}\n`);

      await fulfilled[0]!.value.release();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("replaces stale pid files before acquiring", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-pid-"));
    const pidPath = join(tempDir, "agent.pid");

    try {
      await writeFile(pidPath, "2147483647\n", "utf8");

      const lock = await acquirePidFile(pidPath);
      expect(await readFile(pidPath, "utf8")).toBe(`${process.pid}\n`);

      await lock.release();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

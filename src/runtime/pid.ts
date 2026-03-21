import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PID_ACQUIRE_LOCK_TIMEOUT_MS = 2_000;
const PID_ACQUIRE_LOCK_POLL_MS = 25;

export class PidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PidFileError";
  }
}

export class PidFileLock {
  constructor(private readonly pidPath: string) {}

  async release(): Promise<void> {
    await rm(this.pidPath, { force: true });
  }
}

export async function acquirePidFile(pidPath: string): Promise<PidFileLock> {
  await mkdir(dirname(pidPath), { recursive: true });

  return await withAcquireLock(pidPath, async () => {
    const existingPidFile = await readExistingPidFile(pidPath);
    if (existingPidFile.exists) {
      if (existingPidFile.pid !== null && isProcessAlive(existingPidFile.pid)) {
        throw new PidFileError(`Daemon already running with PID ${existingPidFile.pid}.`);
      }

      await rm(pidPath, { force: true });
    }

    await writeFile(pidPath, `${process.pid}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return new PidFileLock(pidPath);
  });
}

async function withAcquireLock<T>(pidPath: string, callback: () => Promise<T>): Promise<T> {
  const lockPath = `${pidPath}.lock`;
  const deadline = Date.now() + PID_ACQUIRE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      const existingLockFile = await readExistingPidFile(lockPath);
      if (existingLockFile.exists && existingLockFile.pid !== null && isProcessAlive(existingLockFile.pid)) {
        if (Date.now() >= deadline) {
          throw new PidFileError(`Timed out waiting to acquire PID file lock at ${lockPath}.`);
        }

        await delay(PID_ACQUIRE_LOCK_POLL_MS);
        continue;
      }

      await rm(lockPath, { force: true });
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function readExistingPidFile(pidPath: string): Promise<{ exists: boolean; pid: number | null }> {
  try {
    const rawPid = await readFile(pidPath, "utf8");
    const parsed = Number.parseInt(rawPid.trim(), 10);
    return {
      exists: true,
      pid: Number.isInteger(parsed) && parsed > 0 ? parsed : null,
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { exists: false, pid: null };
    }

    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

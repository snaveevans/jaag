import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { PrimitiveHandler } from "../types.ts";
import { sanitizeEnv } from "./sanitize.ts";

export const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;
export const EXECUTE_OUTPUT_LIMIT_BYTES = 64 * 1024;

const BLOCKED_EXECUTABLES = new Set([
  "curl",
  "wget",
  "nc",
  "netcat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "crontab",
]);

const UNSUPPORTED_SHELL_SYNTAX = new Set(["|", "&", ";", "<", ">", "`", "$"]);

type QuoteState = "unquoted" | "single" | "double";

interface ExecuteHandlerOptions {
  executeWorkspaceDir: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  fallbackEnv?: Record<string, string | undefined>;
  defaultTimeoutMs?: number;
}

interface CapturedOutput {
  text: string;
  totalBytes: number;
}

export function createExecuteHandler(options: ExecuteHandlerOptions): PrimitiveHandler {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;
  const fallbackEnv = options.fallbackEnv ?? process.env;
  const runtimeHomeDir = resolveRuntimeHomeDir(options.executeWorkspaceDir, options.homeDir);

  return async (params) => {
    try {
      const command = requireString(params.command, "command");
      const argv = parseCommand(command);
      const blockedExecutable = getBlockedExecutable(argv[0]);

      if (blockedExecutable) {
        return {
          success: false,
          error: `Execute blocked: ${blockedExecutable} is blocked by the runtime execute layer.`,
        };
      }

      const cwd = await resolveExecuteCwd(params.cwd, options.executeWorkspaceDir, runtimeHomeDir);
      const env = sanitizeEnv(options.env ?? fallbackEnv, fallbackEnv, runtimeHomeDir);
      const executable = await resolveExecutable(argv[0], cwd, env);
      const result = await runCommand([executable, ...argv.slice(1)], cwd, env, defaultTimeoutMs);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
      };
    }
  };
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value.trim();
}

function parseCommand(command: string): string[] {
  const argv: string[] = [];
  let currentToken = "";
  let tokenStarted = false;
  let quoteState: QuoteState = "unquoted";
  let escaped = false;

  const pushToken = () => {
    if (!tokenStarted) {
      return;
    }

    argv.push(currentToken);
    currentToken = "";
    tokenStarted = false;
  };

  for (const char of command) {
    if (quoteState === "single") {
      if (char === "'") {
        quoteState = "unquoted";
      } else {
        currentToken += char;
      }
      tokenStarted = true;
      continue;
    }

    if (quoteState === "double") {
      if (escaped) {
        currentToken += char;
        tokenStarted = true;
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        tokenStarted = true;
        continue;
      }

      if (char === '"') {
        quoteState = "unquoted";
        tokenStarted = true;
        continue;
      }

      currentToken += char;
      tokenStarted = true;
      continue;
    }

    if (escaped) {
      currentToken += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }

    if (char === "'") {
      quoteState = "single";
      tokenStarted = true;
      continue;
    }

    if (char === '"') {
      quoteState = "double";
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken();
      continue;
    }

    if (UNSUPPORTED_SHELL_SYNTAX.has(char)) {
      throw new Error(
        `Unsupported shell syntax: ${JSON.stringify(char)} is not supported. Use a simple command without pipes, redirects, shell expansion, or control operators.`,
      );
    }

    currentToken += char;
    tokenStarted = true;
  }

  if (escaped) {
    throw new Error("Invalid command: trailing escapes are not supported.");
  }

  if (quoteState !== "unquoted") {
    throw new Error("Invalid command: unterminated quoted string.");
  }

  pushToken();

  if (argv.length === 0) {
    throw new Error("Invalid command: expected a non-empty string.");
  }

  return argv;
}

async function resolveExecuteCwd(
  value: unknown,
  executeWorkspaceDir: string,
  configuredHomeDir?: string,
): Promise<string> {
  const workspaceDir = await resolveExistingDirectory(
    executeWorkspaceDir,
    `Execute workspace not found: ${executeWorkspaceDir}.`,
  );

  if (value === undefined) {
    return workspaceDir;
  }

  const requestedCwd = requireString(value, "cwd");
  const homeDir = configuredHomeDir ?? resolve(workspaceDir, "..", "..");
  const expandedCwd = requestedCwd === "~" || requestedCwd.startsWith("~/")
    ? resolve(homeDir, requestedCwd.slice(2))
    : requestedCwd;
  const candidatePath = isAbsolute(expandedCwd) ? resolve(expandedCwd) : resolve(workspaceDir, expandedCwd);

  if (!isSameOrDescendant(candidatePath, workspaceDir)) {
    throw new Error("Invalid cwd: cwd must stay within the execute workspace.");
  }

  const resolvedCwd = await resolveExistingDirectory(candidatePath, `Working directory not found: ${requestedCwd}.`);
  if (!isSameOrDescendant(resolvedCwd, workspaceDir)) {
    throw new Error("Invalid cwd: cwd must stay within the execute workspace.");
  }

  return resolvedCwd;
}

function resolveRuntimeHomeDir(executeWorkspaceDir: string, configuredHomeDir?: string): string {
  if (typeof configuredHomeDir === "string" && configuredHomeDir.trim() !== "") {
    return resolve(configuredHomeDir);
  }

  return resolve(executeWorkspaceDir, "..", "..");
}

async function resolveExistingDirectory(targetPath: string, missingMessage: string): Promise<string> {
  let resolvedTarget: string;

  try {
    resolvedTarget = await realpath(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(missingMessage);
    }

    throw error;
  }

  const stats = await lstat(resolvedTarget);
  if (!stats.isDirectory()) {
    throw new Error(`Invalid cwd: ${targetPath} is not a directory.`);
  }

  return resolvedTarget;
}

function isSameOrDescendant(targetPath: string, candidateParent: string): boolean {
  const relativePath = relative(candidateParent, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function resolveExecutable(
  requestedExecutable: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  if (requestedExecutable.includes("/")) {
    const executablePath = isAbsolute(requestedExecutable)
      ? resolve(requestedExecutable)
      : resolve(cwd, requestedExecutable);
    const stats = await lstat(executablePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!stats || stats.isDirectory()) {
      throw new Error(`Command not found: ${requestedExecutable}.`);
    }

    return executablePath;
  }

  const resolvedExecutable = Bun.which(requestedExecutable, {
    PATH: env.PATH,
    cwd,
  });

  if (!resolvedExecutable) {
    throw new Error(`Command not found: ${requestedExecutable}.`);
  }

  return resolvedExecutable;
}

function getBlockedExecutable(commandName: string): string | null {
  const executableName = basename(commandName).toLowerCase();
  return BLOCKED_EXECUTABLES.has(executableName) ? executableName : null;
}

async function runCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const killProcessGroup = process.platform !== "win32";
  const subprocess = Bun.spawn({
    cmd,
    cwd,
    env,
    detached: killProcessGroup,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutPromise = captureStream(subprocess.stdout, "stdout");
  const stderrPromise = captureStream(subprocess.stderr, "stderr");
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    killSubprocess(subprocess, killProcessGroup);
  }, timeoutMs);

  let exitCode = 0;

  try {
    exitCode = await subprocess.exited;
  } finally {
    clearTimeout(timeoutId);
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const renderedStderr = timedOut
    ? appendOutputMessage(stderr.text, `Process timed out after ${formatTimeout(timeoutMs)}.`)
    : stderr.text;

  return {
    exitCode: timedOut ? -1 : exitCode,
    stdout: stdout.text,
    stderr: renderedStderr,
  };
}

function killSubprocess(
  subprocess: { pid: number; kill(signal?: string | number): void },
  killProcessGroup: boolean,
): void {
  if (killProcessGroup) {
    try {
      process.kill(-subprocess.pid, "SIGKILL");
      return;
    } catch (error) {
      if (!isMissingProcessError(error)) {
        // Fall back to direct child termination below.
      }
    }
  }

  try {
    subprocess.kill("SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

async function captureStream(stream: ReadableStream<Uint8Array>, streamName: "stdout" | "stderr"): Promise<CapturedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let storedBytes = 0;
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (storedBytes >= EXECUTE_OUTPUT_LIMIT_BYTES) {
        continue;
      }

      const chunk = value.subarray(0, Math.min(value.byteLength, EXECUTE_OUTPUT_LIMIT_BYTES - storedBytes));
      storedBytes += chunk.byteLength;
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  let text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), storedBytes).toString("utf8");

  if (totalBytes > EXECUTE_OUTPUT_LIMIT_BYTES) {
    text = appendOutputMessage(
      text,
      `[${streamName} truncated at 64KB (${EXECUTE_OUTPUT_LIMIT_BYTES} bytes); total output was ${totalBytes} bytes.]`,
    );
  }

  return {
    text,
    totalBytes,
  };
}

function appendOutputMessage(output: string, message: string): string {
  if (output === "") {
    return message;
  }

  return `${output}${output.endsWith("\n") ? "" : "\n"}${message}`;
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 1000) {
    return `${timeoutMs}ms`;
  }

  const seconds = timeoutMs / 1000;
  if (Number.isInteger(seconds)) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  return `${seconds.toFixed(1)} seconds`;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isMissingProcessError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

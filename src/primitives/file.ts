import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import type { PrimitiveHandler, PrimitiveResult } from "./types.ts";

export const FILE_READ_LIMIT_BYTES = 1024 * 1024;

export interface FileHandlerOptions {
  agentHome: string;
  workspaceDir: string;
  homeDir?: string;
}

interface ResolvedFilePath {
  requestedPath: string;
  resolvedPath: string;
}

interface BlockedPath {
  path: string;
  type: "file" | "directory";
}

export function createFileReadHandler(options: FileHandlerOptions): PrimitiveHandler {
  return async (params) => {
    try {
      const requestedPath = requirePath(params.path);
      const target = resolveFilePath(requestedPath, options);
      const blockedPath = getBlockedPath(target.resolvedPath, getReadBlockedPaths(options));

      if (blockedPath) {
        return {
          success: false,
          error: `Read blocked: ${blockedPath} is protected by the runtime.`,
        };
      }

      const stats = await lstat(target.resolvedPath);
      if (stats.isDirectory()) {
        const entries = await readdir(target.resolvedPath, { withFileTypes: true });
        const listing = entries
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .sort((left, right) => left.localeCompare(right));

        return {
          success: true,
          data: {
            path: target.resolvedPath,
            type: "directory",
            entries: listing,
          },
        };
      }

      const fileHandle = await open(target.resolvedPath, "r");
      let content = "";
      let totalBytes = 0;

      try {
        const fileStats = await fileHandle.stat();
        totalBytes = fileStats.size;
        const bytesToRead = Math.min(totalBytes, FILE_READ_LIMIT_BYTES);

        if (bytesToRead > 0) {
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
          content = buffer.subarray(0, bytesRead).toString("utf8");
        }
      } finally {
        await fileHandle.close();
      }

      const truncated = totalBytes > FILE_READ_LIMIT_BYTES;

      return {
        success: true,
        data: {
          path: target.resolvedPath,
          type: "file",
          content,
          truncated,
          totalBytes,
          ...(truncated
            ? {
                notice: `File truncated at ${FILE_READ_LIMIT_BYTES} bytes; total size is ${totalBytes} bytes.`,
              }
            : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: toFileErrorMessage(error, params.path),
      };
    }
  };
}

export function createFileWriteHandler(options: FileHandlerOptions): PrimitiveHandler {
  return async (params) => {
    try {
      const requestedPath = requirePath(params.path);
      const content = requireContent(params.content);
      const target = resolveFilePath(requestedPath, options);
      const blockedPath = getBlockedPath(target.resolvedPath, getWriteBlockedPaths(options));

      if (blockedPath) {
        return {
          success: false,
          error: `Write blocked: ${blockedPath} is protected by the runtime.`,
        };
      }

      const existing = await lstat(target.resolvedPath).catch((error: unknown) => {
        if (isMissingPathError(error)) {
          return null;
        }

        throw error;
      });

      if (existing?.isDirectory()) {
        return {
          success: false,
          error: `Cannot write file: ${requestedPath} is a directory.`,
        };
      }

      await mkdir(dirname(target.resolvedPath), { recursive: true });
      await writeFile(target.resolvedPath, content, "utf8");

      return {
        success: true,
        data: {
          path: target.resolvedPath,
          bytesWritten: Buffer.byteLength(content, "utf8"),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: toFileErrorMessage(error, params.path),
      };
    }
  };
}

function requirePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Invalid path: expected a non-empty string.");
  }

  return value.trim();
}

function requireContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid content: expected a string.");
  }

  return value;
}

function resolveFilePath(path: string, options: FileHandlerOptions): ResolvedFilePath {
  const homeDir = options.homeDir ?? dirname(options.agentHome) ?? homedir();
  const expandedPath = path === "~" || path.startsWith("~/")
    ? resolve(homeDir, path.slice(2))
    : path;

  return {
    requestedPath: path,
    resolvedPath: isAbsolute(expandedPath)
      ? resolve(expandedPath)
      : resolve(options.workspaceDir, expandedPath),
  };
}

function getReadBlockedPaths(options: FileHandlerOptions): BlockedPath[] {
  return [
    { path: resolve(dirname(options.agentHome), ".agent-policy"), type: "directory" },
    { path: resolve(options.agentHome, "tools", "trusted"), type: "directory" },
    { path: resolve(options.agentHome, "agent.db"), type: "file" },
    { path: resolve(options.agentHome, "agent.pid"), type: "file" },
  ];
}

function getWriteBlockedPaths(options: FileHandlerOptions): BlockedPath[] {
  return [
    ...getReadBlockedPaths(options),
    { path: resolve(options.agentHome, "config.yaml"), type: "file" },
  ];
}

function getBlockedPath(targetPath: string, blockedPaths: BlockedPath[]): string | null {
  for (const blockedPath of blockedPaths) {
    if (blockedPath.type === "file" && normalize(targetPath) === normalize(blockedPath.path)) {
      return blockedPath.path;
    }

    if (blockedPath.type === "directory" && isSameOrDescendant(targetPath, blockedPath.path)) {
      return blockedPath.path;
    }
  }

  return null;
}

function isSameOrDescendant(targetPath: string, candidateParent: string): boolean {
  const relativePath = relative(candidateParent, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function toFileErrorMessage(error: unknown, requestedPath: unknown): string {
  const renderedPath = typeof requestedPath === "string" && requestedPath.trim() !== ""
    ? requestedPath
    : "<invalid path>";

  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return `Path not found: ${renderedPath}`;
    }

    if (code === "EACCES" || code === "EPERM") {
      return `Permission denied: ${renderedPath}`;
    }

    if (code === "EISDIR") {
      return `Expected a file but found a directory: ${renderedPath}`;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

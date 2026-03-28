import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientCommandMessage,
  ClientMessage,
  ConnectionState,
  ContentMessage,
  DisplayMessage,
  HelloMessage,
  ServerMessage
} from "../types.ts";

const RECONNECT_DELAY_MS = 2000;

interface UseDaemonResult {
  connectionState: ConnectionState;
  hello: HelloMessage | null;
  messages: DisplayMessage[];
  streamingContent: string;
  isStreaming: boolean;
  pendingPrompt: ContentMessage | null;
  sendMessage: (text: string) => void;
  sendCommand: (command: string, args?: string[]) => void;
  reconnect: () => void;
  clearMessages: () => void;
}

function formatPromptContent(message: ContentMessage): string {
  if (!message.actions || message.actions.length === 0) {
    return message.content;
  }

  const options = message.actions.map((action) => action.label).join(" / ");
  return `${message.content}\n\nChoices: ${options}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function formatField(label: string, value: string): string {
  return `  ${label.padEnd(13)} ${value}`;
}

function formatValue(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  return fallback;
}

function formatTokenValue(value: unknown): string {
  const numericValue = getNumber(value);
  if (numericValue !== null) {
    return `${numericValue} tokens`;
  }

  const stringValue = getString(value);
  if (!stringValue) {
    return "unknown";
  }

  return /tokens?$/i.test(stringValue) ? stringValue : `${stringValue} tokens`;
}

function formatDurationFromMs(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatUptime(data: Record<string, unknown>): string {
  const formattedUptime = getString(data.uptimeFormatted) ?? getString(data.uptime_formatted);
  if (formattedUptime) {
    return formattedUptime;
  }

  const uptimeMs = getNumber(data.uptime) ?? getNumber(data.uptimeMs) ?? getNumber(data.uptime_ms);
  if (uptimeMs !== null) {
    return formatDurationFromMs(uptimeMs);
  }

  const uptimeSeconds = getNumber(data.uptimeSeconds) ?? getNumber(data.uptime_seconds);
  if (uptimeSeconds !== null) {
    return formatDurationFromMs(uptimeSeconds * 1000);
  }

  return "unknown";
}

const BUILT_IN_TOOL_SUMMARIES: Record<string, string> = {
  http: "Make HTTP requests",
  file_read: "Read files",
  file_write: "Write files",
  execute: "Execute shell commands",
  memory: "Store/retrieve memories",
  schedule: "Manage schedules",
  interact: "User interaction"
};

const SYSTEM_TOOL_SUMMARIES: Record<string, string> = {
  "spec.validate": "Validate a tool spec",
  "spec.register": "Register a tool spec",
  "spec.list": "List registered tool specs",
  "spec.get": "Get a tool spec"
};

function formatToolBullet(tool: unknown, knownSummaries: Record<string, string>): string | null {
  if (typeof tool === "string" && tool.trim() !== "") {
    const summary = knownSummaries[tool] ?? "Available";
    return `  • ${tool} — ${summary}`;
  }

  if (!isRecord(tool)) {
    return null;
  }

  const name = getString(tool.name) ?? getString(tool.tool);
  if (!name) {
    return null;
  }

  const summary = knownSummaries[name] ?? getString(tool.description) ?? "Available";
  return `  • ${name} — ${summary}`;
}

function formatRegistryToolBullet(tool: unknown): string | null {
  if (!isRecord(tool)) {
    return typeof tool === "string" && tool.trim() !== "" ? `  • ${tool}` : null;
  }

  const name = getString(tool.tool) ?? getString(tool.name);
  if (!name) {
    return null;
  }

  const trustTier = getString(tool.trustTier) ?? getString(tool.trust_tier);
  const operationCount = getNumber(tool.operationCount) ?? getNumber(tool.operation_count);

  if (trustTier && operationCount !== null) {
    return `  • ${name} (${trustTier}) — ${operationCount} operations`;
  }

  if (trustTier) {
    return `  • ${name} (${trustTier})`;
  }

  return `  • ${name}`;
}

function formatToolSection(
  title: string,
  tools: unknown[] | null,
  formatter: (tool: unknown) => string | null
): string[] {
  const lines = [title];
  const renderedTools = (tools ?? []).map((tool) => formatter(tool)).filter((tool): tool is string => tool !== null);

  if (renderedTools.length === 0) {
    lines.push("  (none)");
    return lines;
  }

  return [...lines, ...renderedTools];
}

function formatCommandResponse(command: string, data: unknown, error?: string): string {
  if (error) {
    return `Error: ${error}`;
  }

  const normalizedCommand = command.startsWith("/") ? command.slice(1) : command;
  const record = isRecord(data) ? data : null;

  switch (normalizedCommand) {
    case "model": {
      if (!record) {
        break;
      }

      return [
        "Model Configuration",
        formatField("Model:", formatValue(record.model)),
        formatField("Provider:", formatValue(record.provider)),
        formatField("Base URL:", formatValue(record.baseUrl ?? record.base_url)),
        formatField("Context:", formatTokenValue(record.contextLimit ?? record.context_limit)),
        formatField("Max Output:", formatTokenValue(record.maxOutputTokens ?? record.max_output_tokens)),
        formatField("Temperature:", formatValue(record.temperature))
      ].join("\n");
    }
    case "tools": {
      if (!record) {
        break;
      }

      const builtInPrimitives =
        getArray(record.builtInPrimitives)
        ?? getArray(record.builtinPrimitives)
        ?? getArray(record.primitives)
        ?? getArray(record.builtInTools)
        ?? getArray(record.builtinTools);
      const systemTools = getArray(record.systemTools) ?? getArray(record.system);
      const registryTools = getArray(record.registryTools) ?? getArray(record.registry);

      return [
        "Available Tools",
        "",
        ...formatToolSection("Built-in Primitives:", builtInPrimitives, (tool) =>
          formatToolBullet(tool, BUILT_IN_TOOL_SUMMARIES)
        ),
        "",
        ...formatToolSection("System Tools:", systemTools, (tool) =>
          formatToolBullet(tool, SYSTEM_TOOL_SUMMARIES)
        ),
        "",
        ...formatToolSection("Registry Tools:", registryTools, formatRegistryToolBullet)
      ].join("\n");
    }
    case "policy": {
      if (!record) {
        break;
      }

      const summary = getString(record.summary) ?? formatValue(record.summary);
      const ruleCount = getNumber(record.ruleCount) ?? getNumber(record.rule_count) ?? getArray(record.rules)?.length;

      return [
        "Policy Configuration",
        formatField("Path:", formatValue(record.policyPath ?? record.path)),
        formatField("Rules:", ruleCount !== null && ruleCount !== undefined ? String(ruleCount) : "unknown"),
        "",
        "Summary:",
        `  ${summary}`
      ].join("\n");
    }
    case "status": {
      if (!record) {
        break;
      }

      const connectedValue = record.connected ?? record.isConnected ?? record.connectionState;
      const connected =
        typeof connectedValue === "string"
          ? connectedValue
          : typeof connectedValue === "boolean"
            ? (connectedValue ? "yes" : "no")
            : "unknown";

      return [
        "Daemon Status",
        formatField("Uptime:", formatUptime(record)),
        formatField("Model:", formatValue(record.model)),
        formatField("Provider:", formatValue(record.provider)),
        formatField("Port:", formatValue(record.port)),
        formatField("Connected:", connected),
        formatField("Timezone:", formatValue(record.timezone ?? record.timeZone)),
        formatField("Agent Home:", formatValue(record.agentHome ?? record.agent_home)),
        formatField("Workspace:", formatValue(record.workspace ?? record.workspaceDir ?? record.workspace_dir)),
        formatField("Version:", formatValue(record.version))
      ].join("\n");
    }
  }

  const fallback = JSON.stringify(data, null, 2);
  return fallback ?? String(data);
}

export function useDaemon(daemonUrl: string): UseDaemonResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [hello, setHello] = useState<HelloMessage | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<ContentMessage | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manuallyClosedRef = useRef(false);
  const messageIdRef = useRef(0);
  const streamingRef = useRef(false);
  const pendingPromptRef = useRef<ContentMessage | null>(null);
  const connectRef = useRef<() => void>(() => {});

  const nextMessageId = useCallback(() => {
    messageIdRef.current += 1;
    return `message-${messageIdRef.current}`;
  }, []);

  const appendMessage = useCallback(
    (role: DisplayMessage["role"], content: string) => {
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: nextMessageId(),
          role,
          content,
          timestamp: new Date()
        }
      ]);
    },
    [nextMessageId]
  );

  const resetStreamingState = useCallback(() => {
    streamingRef.current = false;
    setIsStreaming(false);
    setStreamingContent("");
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    resetStreamingState();
    pendingPromptRef.current = null;
    setPendingPrompt(null);
  }, [resetStreamingState]);

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "hello": {
          setHello(message);
          return;
        }
        case "stream_chunk": {
          if (!streamingRef.current) {
            streamingRef.current = true;
            setIsStreaming(true);
          }

          setStreamingContent((currentContent) => currentContent + message.content);
          return;
        }
        case "message": {
          if (message.mode === "notify") {
            if (streamingRef.current) {
              resetStreamingState();
            }

            appendMessage("assistant", message.content);
            return;
          }

          if (streamingRef.current) {
            resetStreamingState();
          }

          pendingPromptRef.current = message;
          setPendingPrompt(message);
          appendMessage("assistant", formatPromptContent(message));
          return;
        }
        case "command_response": {
          appendMessage(
            "system",
            formatCommandResponse(message.command, message.data, message.error)
          );
          return;
        }
      }
    },
    [appendMessage, resetStreamingState]
  );

  const scheduleReconnect = useCallback(() => {
    if (manuallyClosedRef.current || reconnectTimeoutRef.current) {
      return;
    }

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      connectRef.current();
    }, RECONNECT_DELAY_MS);
  }, []);

  const connect = useCallback(() => {
    const existingSocket = socketRef.current;
    if (
      existingSocket &&
      (existingSocket.readyState === WebSocket.CONNECTING || existingSocket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    setConnectionState("connecting");

    const socket = new WebSocket(daemonUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) {
        return;
      }

      setConnectionState("connected");
    };

    socket.onmessage = (event) => {
      if (socketRef.current !== socket || typeof event.data !== "string") {
        return;
      }

      try {
        handleServerMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        appendMessage("system", "Received malformed data from daemon.");
      }
    };

    socket.onerror = () => {
      if (socketRef.current !== socket) {
        return;
      }

      setConnectionState("disconnected");
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) {
        return;
      }

      socketRef.current = null;
      setConnectionState("disconnected");
      setHello(null);
      scheduleReconnect();
    };
  }, [appendMessage, daemonUrl, handleServerMessage, scheduleReconnect]);

  useEffect(() => {
    manuallyClosedRef.current = false;
    connectRef.current = connect;
    connect();

    return () => {
      manuallyClosedRef.current = true;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      const socket = socketRef.current;
      socketRef.current = null;

      if (
        socket &&
        (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
      ) {
        socket.close();
      }
    };
  }, [connect]);

  const reconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const socket = socketRef.current;
    socketRef.current = null;

    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      socket.close();
    }

    setHello(null);
    setConnectionState("disconnected");
    connectRef.current();
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content) {
        return;
      }

      appendMessage("user", content);

      const activePrompt = pendingPromptRef.current;
      if (activePrompt) {
        pendingPromptRef.current = null;
        setPendingPrompt(null);
      }

      const payload: ClientMessage = {
        type: "message",
        content,
        ...(activePrompt?.promptId ? { replyToPromptId: activePrompt.promptId } : {})
      };

      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        appendMessage("system", "Disconnected from daemon. Reconnecting...");
        return;
      }

      socket.send(JSON.stringify(payload));
    },
    [appendMessage]
  );

  const sendCommand = useCallback(
    (command: string, args?: string[]) => {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        return;
      }

      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        appendMessage("system", "Disconnected from daemon. Reconnecting...");
        return;
      }

      const payload: ClientCommandMessage = {
        type: "command",
        command: trimmedCommand,
        ...(args && args.length > 0 ? { args } : {})
      };

      socket.send(JSON.stringify(payload));
    },
    [appendMessage]
  );

  return {
    connectionState,
    hello,
    messages,
    streamingContent,
    isStreaming,
    pendingPrompt,
    sendMessage,
    sendCommand,
    reconnect,
    clearMessages
  };
}

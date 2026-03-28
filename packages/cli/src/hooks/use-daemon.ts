import { useCallback, useEffect, useRef, useState } from "react";
import type {
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

  return {
    connectionState,
    hello,
    messages,
    streamingContent,
    isStreaming,
    pendingPrompt,
    sendMessage,
    reconnect,
    clearMessages
  };
}

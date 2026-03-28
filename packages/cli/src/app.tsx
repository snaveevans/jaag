import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, useApp } from "ink";
import { WelcomeBanner } from "./components/welcome-banner.tsx";
import { MessageList } from "./components/message-list.tsx";
import { InputPrompt } from "./components/input-prompt.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { loadCliConfig } from "./config.ts";
import { useDaemon } from "./hooks/use-daemon.ts";
import type { DisplayMessage } from "./types.ts";

type ScreenState = "welcome" | "chat";

function createLocalMessage(content: string): DisplayMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "system",
    content,
    timestamp: new Date()
  };
}

export function App(): React.JSX.Element {
  const { exit } = useApp();
  const [screen, setScreen] = useState<ScreenState>("welcome");
  const [localMessages, setLocalMessages] = useState<DisplayMessage[]>([]);

  const config = useMemo(() => loadCliConfig(), []);
  const {
    connectionState,
    hello,
    messages,
    streamingContent,
    isStreaming,
    pendingPrompt,
    sendMessage,
    clearMessages
  } = useDaemon(config.daemonUrl);

  const combinedMessages = useMemo(
    () =>
      [...messages, ...localMessages].sort(
        (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
      ),
    [localMessages, messages]
  );

  useEffect(() => {
    if (combinedMessages.length > 0 || isStreaming) {
      setScreen("chat");
    }
  }, [combinedMessages.length, isStreaming]);

  const appendSystemMessage = useCallback((content: string) => {
    setLocalMessages((currentMessages) => [...currentMessages, createLocalMessage(content)]);
  }, []);

  const handleSubmit = useCallback(
    (text: string) => {
      sendMessage(text);

      if (screen === "welcome") {
        setScreen("chat");
      }
    },
    [screen, sendMessage]
  );

  const handleSlashCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "quit":
        case "exit": {
          exit();
          return;
        }
        case "clear": {
          clearMessages();
          setLocalMessages([]);
          setScreen("welcome");
          return;
        }
        case "new": {
          clearMessages();
          setLocalMessages([]);
          return;
        }
        case "help": {
          appendSystemMessage(
            [
              "Available commands:",
              "/help  Show available commands",
              "/clear Clear the current conversation",
              "/new   Start a fresh conversation",
              "/quit  Exit Jack",
              "/exit  Exit Jack"
            ].join("\n")
          );
          setScreen("chat");
          return;
        }
        default: {
          appendSystemMessage(`Unknown command: /${command}`);
          setScreen("chat");
        }
      }
    },
    [appendSystemMessage, clearMessages, exit]
  );

  const placeholder = pendingPrompt
    ? "Reply to prompt..."
    : connectionState === "connected"
      ? "Type a message or /help"
      : "Type a message or /help";

  return (
    <Box flexDirection="column" width="100%">
      {screen === "welcome" ? (
        <WelcomeBanner
          version="0.1.0"
          model={hello?.model}
          provider={hello?.provider}
          workspace={hello?.workspace}
          connected={connectionState === "connected"}
        />
      ) : (
        <MessageList
          messages={combinedMessages}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
        />
      )}

      <Box marginTop={1}>
        <InputPrompt
          onSubmit={handleSubmit}
          onSlashCommand={handleSlashCommand}
          placeholder={placeholder}
        />
      </Box>

      <Box marginTop={1}>
        <StatusBar connectionState={connectionState} isStreaming={isStreaming} />
      </Box>
    </Box>
  );
}

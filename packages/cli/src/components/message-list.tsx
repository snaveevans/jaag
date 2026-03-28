import React from "react";
import { Box, Text } from "ink";
import type { DisplayMessage } from "../types.ts";
import { colors } from "../theme.ts";

interface MessageListProps {
  messages: DisplayMessage[];
  streamingContent: string;
  isStreaming: boolean;
}

function renderMessageContent(message: DisplayMessage): { color: string; value: string; dimColor?: boolean } {
  switch (message.role) {
    case "user":
      return {
        color: colors.accent,
        value: `› You: ${message.content}`
      };
    case "assistant":
      return {
        color: colors.primary,
        value: `◆ Jack: ${message.content}`
      };
    case "system":
      return {
        color: colors.dimText,
        value: message.content,
        dimColor: true
      };
  }
}

export function MessageList({
  messages,
  streamingContent,
  isStreaming
}: MessageListProps): React.JSX.Element {
  return (
    <Box flexDirection="column" width="100%">
      {messages.map((message) => {
        const rendered = renderMessageContent(message);

        return (
          <Box key={message.id} marginBottom={1}>
            <Text color={rendered.color} dimColor={rendered.dimColor} wrap="wrap">
              {rendered.value}
            </Text>
          </Box>
        );
      })}

      {isStreaming && streamingContent ? (
        <Text color={colors.primary} wrap="wrap">
          {`◆ Jack: ${streamingContent}▍`}
        </Text>
      ) : null}
    </Box>
  );
}

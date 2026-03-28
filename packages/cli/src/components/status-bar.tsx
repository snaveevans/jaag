import React from "react";
import { Box, Text } from "ink";
import type { ConnectionState } from "../types.ts";
import { colors } from "../theme.ts";

interface StatusBarProps {
  connectionState: ConnectionState;
  isStreaming: boolean;
}

export function StatusBar({
  connectionState,
  isStreaming
}: StatusBarProps): React.JSX.Element {
  if (connectionState === "connected") {
    return (
      <Box width="100%" paddingX={1}>
        <Text color={colors.success}>Connected</Text>
        <Text color={colors.dimText}>
          {isStreaming ? " · Jack is responding..." : " · /help for commands"}
        </Text>
      </Box>
    );
  }

  if (connectionState === "connecting") {
    return (
      <Box width="100%" paddingX={1}>
        <Text color={colors.warning}>Connecting...</Text>
        <Text color={colors.dimText}> · opening daemon socket</Text>
      </Box>
    );
  }

  return (
    <Box width="100%" paddingX={1}>
      <Text color={colors.error}>● Disconnected</Text>
      <Text color={colors.dimText}> — reconnecting...</Text>
    </Box>
  );
}

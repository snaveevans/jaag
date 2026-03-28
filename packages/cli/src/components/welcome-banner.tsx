import React from "react";
import { Box, Text } from "ink";
import { JACKALOPE_MASCOT } from "../mascot.ts";
import { colors } from "../theme.ts";

interface WelcomeBannerProps {
  version: string;
  model?: string;
  provider?: string;
  workspace?: string;
  connected: boolean;
}

export function WelcomeBanner({
  version,
  model,
  provider,
  workspace,
  connected
}: WelcomeBannerProps): React.JSX.Element {
  const modelLine = model && provider ? `${model} · ${provider}` : "Waiting for daemon";
  const workspaceLine = workspace ?? "No workspace available yet";
  const tipLine = connected
    ? "Type a message to start chatting."
    : "Jack will reconnect automatically.";

  return (
    <Box
      borderStyle="round"
      borderColor={colors.muted}
      flexDirection="column"
      paddingX={1}
      width="100%"
    >
      <Text color={colors.primary}>Jack v{version}</Text>
      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column" flexGrow={2} minWidth={0} paddingRight={2}>
          <Text color={colors.text}>Welcome back!</Text>
          <Box marginTop={1}>
            <Text color={colors.primary}>{JACKALOPE_MASCOT}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.text}>{modelLine}</Text>
            <Text color={colors.dimText}>{workspaceLine}</Text>
          </Box>
        </Box>

        <Box flexDirection="column" flexGrow={3} minWidth={0}>
          <Text color={colors.text}>Tips for getting started</Text>
          <Text color={colors.dimText}>{tipLine}</Text>

          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.text}>Recent activity</Text>
            <Text color={colors.dimText}>No recent activity</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

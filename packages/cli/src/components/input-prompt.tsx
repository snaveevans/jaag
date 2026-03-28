import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { colors } from "../theme.ts";

interface InputPromptProps {
  onSubmit: (text: string) => void;
  onSlashCommand: (command: string, args: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function InputPrompt({
  onSubmit,
  onSlashCommand,
  placeholder,
  disabled = false
}: InputPromptProps): React.JSX.Element {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || disabled) {
        return;
      }

      setValue("");

      if (trimmed.startsWith("/")) {
        const [command = "", ...rest] = trimmed.slice(1).split(/\s+/);
        onSlashCommand(command.toLowerCase(), rest.join(" "));
        return;
      }

      onSubmit(trimmed);
    },
    [disabled, onSlashCommand, onSubmit]
  );

  return (
    <Box width="100%">
      <Text color={colors.primary}>› </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        focus={!disabled}
      />
    </Box>
  );
}

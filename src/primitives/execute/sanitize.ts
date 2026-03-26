const SAFE_ENV_VARS = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR"] as const;

const SENSITIVE_ENV_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SESSION|COOKIE)/i;

export function sanitizeEnv(
  sourceEnv: Record<string, string | undefined> = process.env,
  fallbackEnv: Record<string, string | undefined> = process.env,
  configuredHomeDir?: string,
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const key of SAFE_ENV_VARS) {
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) {
      continue;
    }

    const value = key === "HOME" && typeof configuredHomeDir === "string" && configuredHomeDir !== ""
      ? configuredHomeDir
      : sourceEnv[key] ?? fallbackEnv[key];
    if (typeof value === "string" && value !== "") {
      clean[key] = value;
    }
  }

  return clean;
}

export { SAFE_ENV_VARS, SENSITIVE_ENV_KEY_PATTERN };

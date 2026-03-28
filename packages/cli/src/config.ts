export interface CliConfig {
  daemonUrl: string;
}

export function loadCliConfig(): CliConfig {
  return {
    daemonUrl: process.env.JACK_DAEMON_URL ?? "ws://127.0.0.1:8765"
  };
}

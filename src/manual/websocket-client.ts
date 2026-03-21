const DEFAULT_URL = "ws://127.0.0.1:8765";
const DEFAULT_IDLE_MS = 1500;

const prompt = Bun.argv.slice(2).join(" ").trim();
if (prompt === "") {
  console.error('Usage: bun run manual:ws "your prompt"');
  process.exit(1);
}

const url = process.env.AGENT_WS_URL?.trim() || DEFAULT_URL;
const idleMs = resolveIdleMs(process.env.AGENT_WS_IDLE_MS);
let streamingSessionId: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const socket = new WebSocket(url);

socket.addEventListener("open", () => {
  console.log(`Connected to ${url}`);
  console.log(`Sent prompt: ${prompt}`);
  if (idleMs > 0) {
    console.log(`Waiting for streamed chunks and messages. Auto-close after ${idleMs}ms idle.`);
  } else {
    console.log("Waiting for streamed chunks and messages. Press Ctrl-C to exit.");
  }
  socket.send(JSON.stringify({ type: "message", content: prompt }));
});

socket.addEventListener("message", async (event) => {
  scheduleIdleClose();
  const raw = await normalizeEventData(event.data);
  const envelope = parseEnvelope(raw);

  if (!envelope) {
    finishStreamLine();
    console.log(`[raw] ${raw}`);
    return;
  }

  if (envelope.type === "stream_chunk" && typeof envelope.content === "string") {
    const sessionId = typeof envelope.sessionId === "string" ? envelope.sessionId : "unknown-session";

    if (streamingSessionId !== sessionId) {
      finishStreamLine();
      console.log(`[stream ${sessionId}]`);
      streamingSessionId = sessionId;
    }

    process.stdout.write(envelope.content);
    return;
  }

  finishStreamLine();

  if (envelope.type === "message" && typeof envelope.content === "string") {
    const mode = typeof envelope.mode === "string" ? envelope.mode : "unknown";
    const sessionId = typeof envelope.sessionId === "string" ? envelope.sessionId : "unknown-session";
    console.log(`[message ${mode} ${sessionId}] ${envelope.content}`);
    return;
  }

  console.log(`[event] ${JSON.stringify(envelope)}`);
});

socket.addEventListener("error", () => {
  clearIdleTimer();
  finishStreamLine();
  console.error(`WebSocket error for ${url}`);
});

socket.addEventListener("close", (event) => {
  clearIdleTimer();
  finishStreamLine();

  if (event.code === 1000 && event.reason === "Client exiting") {
    console.log("Closed.");
    process.exit(0);
  }

  const reasonSuffix = event.reason ? `: ${event.reason}` : "";
  console.log(`Socket closed (${event.code}${reasonSuffix})`);
  process.exit(event.code === 1000 ? 0 : 1);
});

process.on("SIGINT", () => {
  clearIdleTimer();
  finishStreamLine();
  socket.close(1000, "Client exiting");
});

function scheduleIdleClose(): void {
  if (idleMs === 0) {
    return;
  }

  clearIdleTimer();
  idleTimer = setTimeout(() => {
    finishStreamLine();
    console.log(`Idle for ${idleMs}ms; closing.`);
    socket.close(1000, "Idle timeout");
  }, idleMs);
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function finishStreamLine(): void {
  if (streamingSessionId !== null) {
    process.stdout.write("\n");
    streamingSessionId = null;
  }
}

async function normalizeEventData(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }

  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }

  if (data instanceof Blob) {
    return await data.text();
  }

  return String(data);
}

function parseEnvelope(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveIdleMs(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_IDLE_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`Invalid AGENT_WS_IDLE_MS \"${rawValue}\", using ${DEFAULT_IDLE_MS}.`);
    return DEFAULT_IDLE_MS;
  }

  return parsed;
}

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
let activePromptId: string | null = null;
let activePromptMode: string | null = null;
let promptLoopStarted = false;

const socket = new WebSocket(url);

socket.addEventListener("open", () => {
  console.log(`Connected to ${url}`);
  console.log(`Sent initial prompt: ${prompt}`);
  if (idleMs > 0) {
    console.log(`Waiting for streamed chunks and messages. Type replies in stdin. Auto-close after ${idleMs}ms idle.`);
  } else {
    console.log("Waiting for streamed chunks and messages. Type replies in stdin. Press Ctrl-C to exit.");
  }
  socket.send(JSON.stringify({ type: "message", content: prompt }));
  startPromptLoop();
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
    const promptId = getPromptId(envelope);

    if ((mode === "ask" || mode === "approve") && promptId) {
      activePromptId = promptId;
      activePromptMode = mode;
      console.log(`[prompt ${mode} ${sessionId} ${promptId}] ${envelope.content}`);
      console.log(`reply> `);
      return;
    }

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

function startPromptLoop(): void {
  if (promptLoopStarted) {
    return;
  }

  promptLoopStarted = true;
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    while (buffer.includes("\n")) {
      const newlineIndex = buffer.indexOf("\n");
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      void handleInputLine(rawLine.replace(/\r$/, ""));
    }
  });
}

async function handleInputLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") {
    return;
  }

  if (socket.readyState !== WebSocket.OPEN) {
    console.error("Socket is not open; cannot send input.");
    return;
  }

  const payload: Record<string, unknown> = {
    type: "message",
    content: trimmed,
  };

  if (activePromptId) {
    payload.replyToPromptId = activePromptId;
    if (activePromptMode === "approve") {
      console.log(`[reply ${activePromptId}] ${trimmed}`);
    }
  } else {
    console.log(`[message] ${trimmed}`);
  }

  socket.send(JSON.stringify(payload));
  activePromptId = null;
  activePromptMode = null;
}

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

function getPromptId(envelope: Record<string, unknown>): string | null {
  const promptId = envelope.promptId;
  if (typeof promptId === "string" && promptId.trim() !== "") {
    return promptId.trim();
  }

  const snakeCasePromptId = envelope.prompt_id;
  if (typeof snakeCasePromptId === "string" && snakeCasePromptId.trim() !== "") {
    return snakeCasePromptId.trim();
  }

  return null;
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

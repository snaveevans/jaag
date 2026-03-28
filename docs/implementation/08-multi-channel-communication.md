# 08 — Multi-Channel Communication

> **Status:** Spec  
> **Audience:** Implementing agent  
> **Depends on:** Slices 01-07 (all existing infrastructure)

---

## 1. Goal

Enable the daemon to serve multiple communication channels simultaneously — starting with CLI (existing) and Telegram — so a user can interact with the agent from their desk via CLI and check in or receive notifications via Telegram while away.

Two interaction modes are in scope:

- **Mode 1 (Observe):** A Telegram session can query what an active CLI session is doing by reading its message log and summarizing it. The observe session is a normal agent session with access to a `sessions` primitive. It does not modify or inject into the observed session.
- **Mode 3 (Independent):** A Telegram session can run its own conversations (reminders, questions from memory, schedule management) independently of any CLI session. These sessions use a restricted primitive set that prevents workspace interference.

**Out of scope (Mode 2):** Injecting messages into another session's conversation from a different channel. This is deferred.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                        DAEMON                           │
│                                                         │
│  ┌───────────────┐    ┌──────────────────────────────┐  │
│  │ WebSocket     │    │ CommunicationRouter          │  │
│  │ Server        │───▶│                              │  │
│  │ (multi-conn)  │    │  Manages per-connection      │  │
│  │               │    │  adapters, routes messages    │  │
│  │               │    │  to/from sessions by          │  │
│  │               │    │  connectionId                 │  │
│  └───────────────┘    └──────────┬───────────────────┘  │
│                                  │                      │
│                       ┌──────────▼───────────────────┐  │
│                       │ SessionManager (upgraded)    │  │
│                       │                              │  │
│                       │  Multiple concurrent         │  │
│                       │  sessions, each bound to a   │  │
│                       │  connectionId + channelId    │  │
│                       └──────────┬───────────────────┘  │
│                                  │                      │
│                       ┌──────────▼───────────────────┐  │
│                       │ AgentRuntime (per session)   │  │
│                       │                              │  │
│                       │  Primitives + Policy +       │  │
│                       │  Workspace Write Lock        │  │
│                       └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

┌──────────────┐                ┌──────────────────────┐
│   CLI (Ink)  │──WebSocket────▶│                      │
└──────────────┘                │  Daemon WebSocket    │
                                │  Server (:8765)      │
┌──────────────┐                │                      │
│   Telegram   │──WebSocket────▶│                      │
│   Gateway    │                └──────────────────────┘
│  (separate   │
│   process)   │
│              │
│  Telegram    │
│  Bot API     │
└──────┬───────┘
       │
       ▼
  User on phone
```

**Key principle:** The daemon does not know about Telegram. It speaks its existing WebSocket protocol. The Telegram Gateway is a separate process that translates between the Telegram Bot API and the daemon's WebSocket protocol. To the daemon, the gateway is just another WebSocket client.

---

## 3. Component Design

### 3.1 WebSocket Server — Multi-Connection Support

**File:** `src/communication/websocket.ts`

**Current behavior:** Accepts one WebSocket connection at a time. A new connection replaces the previous one (line 76-79 in current code). A single `socket` field holds the active connection.

**New behavior:** Accept multiple simultaneous WebSocket connections. Each connection is identified and tracked independently.

#### 3.1.1 Connection Identification

When a client connects, it must send an `identify` envelope as its first message:

```typescript
type IdentifyEnvelope = {
  type: "identify";
  channelId: string;   // e.g. "cli:local", "telegram-gateway"
  clientId?: string;    // optional unique client instance ID (for reconnection tracking)
};
```

Until a connection sends `identify`, no other messages from that connection are processed. The server should buffer or reject pre-identify messages.

If a new connection identifies with the same `channelId` as an existing connection, the **old** connection is replaced (existing behavior, scoped per channel). This preserves the CLI's current reconnection behavior.

#### 3.1.2 Connection Registry

Replace the single `socket` field with a connection registry:

```typescript
interface ConnectionEntry {
  connectionId: string;         // UUID assigned on connect
  channelId: string;            // from identify envelope
  clientId: string | undefined; // optional, from identify envelope
  socket: ServerWebSocket<undefined>;
  identified: boolean;
  outboundQueue: QueuedEvent[];
  outboundQueueBytes: number;
}
```

The `WebSocketCommunicationAdapter` becomes `WebSocketServer` (rename optional but encouraged for clarity). It no longer implements `CommunicationAdapter` directly. Instead, it manages connections and exposes methods that the `CommunicationRouter` uses.

**Exposed API:**

```typescript
class WebSocketServer {
  async start(): Promise<void>;
  async stop(): Promise<void>;

  // Send a message to a specific connection
  async send(connectionId: string, message: OutboundMessage): Promise<DeliveryResult>;
  async sendStreamChunk(connectionId: string, sessionId: string, content: string): Promise<DeliveryResult>;

  // Register handler for inbound messages (includes connectionId)
  onMessage(handler: (connectionId: string, message: InboundMessage) => void): void;

  // Connection lifecycle events
  onConnect(handler: (connectionId: string, channelId: string) => void): void;
  onDisconnect(handler: (connectionId: string) => void): void;

  // Query connection state
  isConnected(connectionId: string): boolean;
  getConnection(connectionId: string): ConnectionEntry | undefined;
  listConnections(): ConnectionEntry[];
}
```

Each connection keeps its own outbound queue (existing queue logic moves from singleton to per-connection). The max buffer limits apply per connection.

#### 3.1.3 Backward Compatibility

The CLI client (`packages/cli`) currently does not send an `identify` message. Two options:

- **Option A (recommended):** Update the CLI to send `identify` with `channelId: "cli:local"` on connect. This is a one-line change in `packages/cli/src/hooks/use-daemon.ts`.
- **Option B:** The server assigns a default `channelId` of `"cli:unknown"` if the first message is not `identify`. This is fragile and not recommended.

Go with Option A. The CLI sends `identify` immediately after receiving the `hello` payload.

---

### 3.2 CommunicationRouter

**New file:** `src/communication/router.ts`

The router sits between the WebSocket server and the runtime layer. It maps connections to sessions and routes messages bidirectionally.

```typescript
interface SessionBinding {
  sessionId: string;
  connectionId: string;
  channelId: string;
}

class CommunicationRouter {
  constructor(options: {
    server: WebSocketServer;
    logger: Logger;
  });

  // Bind a session to a specific connection
  bindSession(sessionId: string, connectionId: string): void;

  // Unbind when session completes
  unbindSession(sessionId: string): void;

  // Send a message to the connection bound to a session
  async sendToSession(sessionId: string, message: OutboundMessage): Promise<DeliveryResult>;
  async sendStreamChunkToSession(sessionId: string, content: string): Promise<DeliveryResult>;

  // Register handler for inbound messages (enriched with connection context)
  onMessage(handler: (connectionId: string, channelId: string, message: InboundMessage) => void): void;

  // Query
  getBindingForSession(sessionId: string): SessionBinding | undefined;
  getConnectionChannelId(connectionId: string): string | undefined;
  listActiveBindings(): SessionBinding[];
}
```

**How it works:**

1. The router subscribes to the `WebSocketServer`'s `onMessage`, `onConnect`, and `onDisconnect` events.
2. When a message arrives from a connection, the router resolves the `channelId` and forwards it to its own `onMessage` handler (consumed by the runtime orchestrator — see 3.4).
3. When a session sends an outbound message (via the `InteractionHandler` or streaming), it calls `sendToSession(sessionId, ...)`. The router looks up the session's bound connection and sends through the `WebSocketServer`.
4. When a connection disconnects, the router does NOT immediately kill sessions bound to it. Sessions continue running (they may be mid-tool-call). Messages queue in the connection's buffer until reconnection.

#### 3.2.1 CommunicationAdapter Compatibility

The `AgentRuntime` currently takes a `CommunicationAdapter` in its constructor. Rather than rewriting `AgentRuntime` to use the router directly, create a thin adapter that wraps the router for a specific session:

```typescript
class SessionScopedAdapter implements CommunicationAdapter {
  constructor(
    private readonly sessionId: string,
    private readonly router: CommunicationRouter,
  );

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    return this.router.sendToSession(this.sessionId, message);
  }

  async sendStreamChunk(sessionId: string, content: string): Promise<DeliveryResult> {
    return this.router.sendStreamChunkToSession(sessionId, content);
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    // The runtime orchestrator routes inbound messages to the right session.
    // This adapter registers the handler so the orchestrator can call it.
    this.messageHandler = handler;
  }

  isConnected(): boolean {
    const binding = this.router.getBindingForSession(this.sessionId);
    if (!binding) return false;
    return this.router.server.isConnected(binding.connectionId);
  }
}
```

This preserves the existing `AgentRuntime` interface. Each session gets its own adapter instance.

---

### 3.3 SessionManager — Multi-Session Support

**File:** `src/session/manager.ts`

**Current behavior:** Tracks one "interactive" session via `interactiveSessionId`. All other sessions are triggered (scheduled). The single interactive session is reused for the same CLI connection.

**New behavior:** Track multiple interactive sessions, each associated with a `channelId`. A channel gets at most one active interactive session at a time (same reuse behavior, but per-channel).

#### 3.3.1 Session Metadata

Add metadata to `AgentSession` (file: `src/session/session.ts`):

```typescript
// New fields on AgentSessionOptions:
channelId?: string;       // "cli:local", "telegram-gateway:user:12345", etc.
taskSummary?: string;     // Human-readable description of what the session is doing

// New fields on AgentSession:
readonly channelId: string;
taskSummary: string;

// New method:
updateTaskSummary(summary: string): void;
```

The `channelId` defaults to `"unknown"` if not provided (backward compat for tests).

The `taskSummary` is updated by the runtime after the first LLM response, using the LLM's own understanding of what the user asked. Implementation: after the first assistant text response in a session, the runtime calls `session.updateTaskSummary(...)` with a truncated version of the first user message (first 120 chars). This is simple and good enough — the `sessions.read` primitive gives full context when needed.

#### 3.3.2 Multi-Session Tracking

Replace the single `interactiveSessionId` with a per-channel map:

```typescript
// Replace:
private interactiveSessionId: string | null = null;

// With:
private readonly interactiveSessionsByChannel = new Map<string, string>();
```

**`getOrCreateInteractiveSession` changes:**

```typescript
async getOrCreateInteractiveSession(channelId: string, now = new Date()): Promise<AgentSession>
```

The method now takes a `channelId` parameter. It looks up the active interactive session for that channel. If none exists or the existing one is terminal/expired, it creates a new one with the `channelId` set.

**`listSessions` stays the same** but now returns sessions across all channels.

**New methods:**

```typescript
// Get metadata for all non-terminal sessions (for the sessions primitive)
listActiveSessionSummaries(): SessionSummary[];

// Get the message log for a specific session (for observe mode)
getSessionMessages(sessionId: string): InternalMessage[] | null;
```

```typescript
interface SessionSummary {
  sessionId: string;
  channelId: string;
  status: SessionStatus;
  triggerSource: TriggerSource;
  taskSummary: string;
  createdAt: string;       // ISO 8601
  lastActivityAt: string;  // ISO 8601
  iterationCount: number;
  messageCount: number;
}
```

#### 3.3.3 Session Cleanup

Currently `cleanupExpiredSessions` only cleans the single interactive session. Update it to iterate over all interactive sessions by channel and clean expired ones.

---

### 3.4 Runtime Orchestrator

**New file:** `src/runtime/orchestrator.ts`

Currently, `src/index.ts` wires everything together imperatively: one adapter, one runtime, one session manager. With multi-channel, there's enough routing logic to justify a dedicated orchestrator.

The orchestrator replaces the direct wiring in `src/index.ts`.

```typescript
interface RuntimeOrchestratorOptions {
  server: WebSocketServer;
  llmProvider: LLMProvider;
  modelConfig: ModelConfig;
  sessionManager: SessionManager;
  primitiveDispatcher: PrimitiveDispatcher;
  workspaceLock: WorkspaceWriteLock;
  logger: Logger;
}

class RuntimeOrchestrator {
  private readonly runtimes = new Map<string, AgentRuntime>();  // sessionId → runtime
  // ...

  start(): void;
  async shutdown(timeoutMs?: number): Promise<boolean>;
  launchTriggeredSchedule(schedule: TriggeredScheduleContext, channelId: string, firedAt?: Date): Promise<boolean>;
}
```

**How it works:**

1. Listens for inbound messages from the `CommunicationRouter`.
2. When a message arrives from connection `C` with channel `ch`:
   a. Calls `sessionManager.getOrCreateInteractiveSession(ch)` to get/create a session.
   b. If this is a new session, creates a `SessionScopedAdapter` for it, creates a new `AgentRuntime` for it, binds the session to the connection via the router, and starts the runtime.
   c. If this is an existing session, delivers the inbound message to the existing runtime's message handler.
3. When a session completes or fails, cleans up the runtime and unbinds the session.
4. When a connection disconnects, sessions remain alive (messages queue). When the same `channelId` reconnects, existing sessions re-bind to the new connection.

**Important:** Each session gets its own `AgentRuntime` instance. The `AgentRuntime` is designed to manage one session's lifecycle. The orchestrator manages many runtimes.

However, all runtimes share the same `PrimitiveDispatcher` and `SessionManager` instances. This means:
- Memory is shared across sessions (correct — this is the cross-channel continuity mechanism).
- Policy is shared (correct — same rules apply everywhere).
- The workspace write lock is shared (correct — see 3.6).

#### 3.4.1 Per-Channel Primitive Restrictions

The orchestrator determines which primitives are available to a session based on its `channelId`. This is enforced by providing a filtered set of tool declarations to the LLM and by checking at dispatch time.

**Restriction rules (configurable later, hardcoded for v1):**

| Channel pattern | Allowed primitives |
|---|---|
| `cli:*` | All 7 primitives + system tools + spec operations + `sessions` |
| `telegram-gateway:*` | `memory`, `schedule`, `interact`, `http`, `file_read`, `sessions` + system tools + spec operations |

The `telegram-gateway:*` channel **cannot** use `file_write` or `execute`. It **can** use `file_read` (useful for checking file contents when answering questions) and `http` (needed for tool spec operations like checking GitHub issues).

**Enforcement approach — two layers:**

1. **LLM-level:** The `AgentRuntime` for a Telegram session receives a filtered `getToolDeclarations()` list that omits `file_write` and `execute`. The LLM never sees these tools and won't try to call them.

2. **Dispatch-level (safety net):** The `PrimitiveDispatcher.dispatch()` method receives the `PrimitiveContext`, which now includes the `channelId`. If a restricted primitive is somehow called, dispatch returns an error result. This is the backstop.

To implement this, extend `PrimitiveContext`:

```typescript
export interface PrimitiveContext {
  sessionId: string;
  channelId: string;              // NEW
  triggerSource?: "user" | "schedule";
}
```

And add a check at the top of `PrimitiveDispatcher.dispatch()`:

```typescript
if (this.isRestrictedPrimitive(primitiveName, context.channelId)) {
  return {
    success: false,
    error: `The ${primitiveName} primitive is not available on this channel. Use a CLI session for file and command operations.`,
  };
}
```

The restriction map should be a simple lookup, not a complex policy engine feature. Keep it in the dispatcher or pass it as a constructor option.

---

### 3.5 The `sessions` Primitive

**New file:** `src/primitives/sessions.ts`

A new primitive that allows any session to list active sessions and read another session's message log. This is the foundation of observe mode.

#### 3.5.1 Tool Declaration

```typescript
{
  name: "sessions",
  description: "List active agent sessions or read the message log of a specific session. Use this to check what other sessions are working on.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list", "read"],
        description: "Operation to perform.",
      },
      session_id: {
        type: "string",
        description: "Session ID to read. Required for read operation.",
      },
      last_n: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Number of most recent messages to return for read. Defaults to 20.",
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
}
```

#### 3.5.2 Handler

```typescript
function createSessionsHandler(options: {
  sessionManager: SessionManager;
}): PrimitiveHandler {
  return async (params, context) => {
    const operation = params.operation as string;

    switch (operation) {
      case "list": {
        const summaries = options.sessionManager.listActiveSessionSummaries();
        // Exclude the calling session from the list (you don't need to observe yourself)
        const filtered = summaries.filter(s => s.sessionId !== context.sessionId);
        return {
          success: true,
          data: { sessions: filtered, count: filtered.length },
        };
      }

      case "read": {
        const sessionId = params.session_id as string;
        if (!sessionId) {
          return { success: false, error: "session_id is required for read operation." };
        }

        const messages = options.sessionManager.getSessionMessages(sessionId);
        if (!messages) {
          return { success: false, error: `Session ${sessionId} not found.` };
        }

        const lastN = Math.min((params.last_n as number) || 20, 50);
        const recentMessages = messages.slice(-lastN);

        // Sanitize: strip system prompt content, keep role + content + tool call names
        const sanitized = recentMessages.map(msg => ({
          role: msg.role,
          content: msg.role === "system" ? "[system prompt]" : truncate(msg.content, 500),
          ...(msg.toolCalls ? { toolCalls: msg.toolCalls.map(tc => ({ name: tc.name })) } : {}),
        }));

        return {
          success: true,
          data: { sessionId, messages: sanitized, totalMessages: messages.length },
        };
      }

      default:
        return { success: false, error: `Unknown sessions operation: ${operation}` };
    }
  };
}
```

**Key design decisions:**

- The `read` operation sanitizes messages: system prompts are redacted (they contain internal instructions), message content is truncated to 500 chars per message (the observing LLM only needs a summary, not the full output of every tool call), and tool calls are reduced to just their names.
- The calling session is excluded from `list` results to avoid confusion.
- This primitive is **read-only**. There is no `write`, `inject`, or `modify` operation. This is what makes Mode 2 out of scope.

#### 3.5.3 Registration

Register the `sessions` primitive in `PrimitiveDispatcher`:
- Add the declaration to `RAW_PRIMITIVE_DECLARATIONS` (or to a separate `SESSIONS_PRIMITIVE_DECLARATION` constant registered alongside them).
- Add the handler to the `handlers` map in the constructor.
- The `sessions` handler requires a reference to `SessionManager`. Pass it via `PrimitiveDispatcherOptions`.

The `sessions` primitive is **policy-exempt** (like `memory` and `interact`). It only reads metadata and sanitized logs — no side effects.

---

### 3.6 Workspace Write Lock

**New file:** `src/runtime/workspace-lock.ts`

A simple workspace-level write lock that prevents two sessions from using `file_write` or `execute` simultaneously.

```typescript
class WorkspaceWriteLock {
  private holder: { sessionId: string; channelId: string; acquiredAt: Date } | null = null;

  // Attempt to acquire the lock. Returns true if acquired, false if held by another session.
  acquire(sessionId: string, channelId: string): boolean {
    if (this.holder === null || this.holder.sessionId === sessionId) {
      this.holder = { sessionId, channelId, acquiredAt: new Date() };
      return true;
    }
    return false;
  }

  // Release the lock. Only the holding session can release.
  release(sessionId: string): void {
    if (this.holder?.sessionId === sessionId) {
      this.holder = null;
    }
  }

  // Check if a session holds or can acquire the lock.
  isAvailableFor(sessionId: string): boolean {
    return this.holder === null || this.holder.sessionId === sessionId;
  }

  // Get info about the current holder (for error messages).
  getHolder(): { sessionId: string; channelId: string; acquiredAt: Date } | null {
    return this.holder ? { ...this.holder } : null;
  }
}
```

**Integration with PrimitiveDispatcher:**

At the top of `dispatch()`, before executing `file_write` or `execute`:

```typescript
if ((primitiveName === "file_write" || primitiveName === "execute") && this.workspaceLock) {
  if (!this.workspaceLock.acquire(context.sessionId, context.channelId)) {
    const holder = this.workspaceLock.getHolder();
    return {
      success: false,
      error: `Workspace is currently in use by another session (channel: ${holder?.channelId}, started: ${holder?.acquiredAt.toISOString()}). File writes and command execution are blocked to prevent interference. Use the sessions primitive to check what the other session is doing.`,
    };
  }
}
```

**Lock lifecycle:**

- The lock is acquired lazily — only when a session first calls `file_write` or `execute`.
- The lock is released when the session completes, fails, or expires. The `SessionManager` (or orchestrator) calls `workspaceLock.release(sessionId)` during session cleanup.
- The lock is **not** time-based. A long-running coding session holds the lock for its entire duration. This is intentional — workspace contention between two coding sessions is the problem we're preventing.
- If the holding session's connection disconnects, the lock is **not** released. The session is still alive (it may be mid-tool-call). The lock is only released on session termination.

**System prompt awareness:**

When a session starts on a channel that restricts `file_write`/`execute` (i.e., Telegram), the system prompt should include:

> "You are connected via a remote channel. You cannot write files or execute commands in this session. Use the `sessions` primitive to observe active coding sessions. Use `memory` to recall previous work. If the user needs code changes, suggest they use a CLI session."

When a CLI session starts and the workspace lock is already held (edge case: two CLI connections), the system prompt should include:

> "Another session currently holds the workspace write lock. File writes and command execution will be blocked until that session completes."

---

### 3.7 Telegram Gateway

**New directory:** `packages/telegram-gateway/`

A separate Bun process that translates between the Telegram Bot API and the daemon's WebSocket protocol.

#### 3.7.1 Responsibilities

1. Long-poll Telegram Bot API for updates (or webhook — long-poll is simpler for v1).
2. Translate Telegram messages → daemon WebSocket envelopes.
3. Translate daemon WebSocket envelopes → Telegram Bot API calls.
4. Handle the `identify` handshake on WebSocket connect.
5. Map Telegram user IDs to channel IDs.
6. Render `approve` mode messages with Telegram inline keyboard buttons.
7. Reconnect to daemon WebSocket if connection drops.

#### 3.7.2 Message Translation

**Inbound (Telegram → daemon):**

```
Telegram update: { message: { chat: { id: 12345 }, text: "what's happening?" } }
  → WebSocket: { type: "message", content: "what's happening?" }
```

The gateway connects once to the daemon as `channelId: "telegram-gateway"`. All Telegram messages are forwarded through this single connection. If multi-user support is needed later, the `channelId` can be parameterized per Telegram user (e.g., `"telegram:user:12345"`). For v1, single-user is sufficient.

**Outbound (daemon → Telegram):**

```
WebSocket: { type: "message", mode: "notify", content: "Your CLI session is refactoring auth..." }
  → Telegram: sendMessage(chatId, content, { parse_mode: "Markdown" })

WebSocket: { type: "message", mode: "approve", content: "Send this email? Reply yes or no.", actions: [...] }
  → Telegram: sendMessage(chatId, content, { reply_markup: { inline_keyboard: [[{ text: "Allow", callback_data: "yes" }, { text: "Deny", callback_data: "no" }]] } })

WebSocket: { type: "message", mode: "ask", content: "What priority should this be?", promptId: "abc" }
  → Telegram: sendMessage(chatId, content)
  (user replies)
  → WebSocket: { type: "message", content: "high", replyToPromptId: "abc" }
```

**Handling `stream_chunk`:**

Telegram does not support streaming. The gateway should buffer `stream_chunk` messages and send them as a single message when streaming is complete (detected by receiving a `type: "message"` envelope after a sequence of chunks, or by a configurable debounce timeout).

Alternatively, for v1, the gateway can simply ignore `stream_chunk` messages and only render the final `message` envelope. This is simpler and the user on Telegram doesn't need real-time streaming — they just want the result.

#### 3.7.3 Configuration

The gateway reads its config from environment variables or a YAML file:

```yaml
telegram:
  bot_token_env: TELEGRAM_BOT_TOKEN  # env var name containing the token
  allowed_user_ids: [12345]          # whitelist of Telegram user IDs (security)

daemon:
  websocket_url: ws://127.0.0.1:8765
```

The `allowed_user_ids` whitelist is critical. Without it, anyone who discovers the bot can interact with your agent daemon.

#### 3.7.4 Minimal Dependencies

The gateway should use only:
- Bun built-in `fetch` for Telegram Bot API calls
- Bun built-in WebSocket client for daemon connection
- `yaml` for config parsing (already a project dependency)

No Telegram SDK. The Bot API is simple enough to call directly with `fetch`.

#### 3.7.5 File Structure

```
packages/telegram-gateway/
  src/
    index.ts              # Entry point, process lifecycle
    config.ts             # Config loading
    telegram-client.ts    # Telegram Bot API wrapper (sendMessage, getUpdates, answerCallbackQuery)
    daemon-client.ts      # WebSocket client to daemon (connect, identify, send, receive)
    translator.ts         # Message translation logic (daemon ↔ Telegram)
  package.json
```

---

### 3.8 Schedule Channel Routing

**File:** `src/scheduler/types.ts`

Add a `channel` field to `ScheduleRecord` and `ScheduleContextPayload`:

```typescript
export interface ScheduleRecord {
  // ... existing fields ...
  channel: string | null;  // NEW: target channel for triggered session output
}

export interface ScheduleContextPayload extends Record<string, unknown> {
  instruction: string;
  channel?: string;  // NEW: where to deliver the triggered session's output
}

export interface TriggeredScheduleContext {
  // ... existing fields ...
  channel: string | null;  // NEW
}
```

**Schema migration:** Add `channel TEXT` column to the `schedules` table. Nullable. Defaults to `null` (use daemon default channel).

**Schedule primitive update:** The `schedule` tool declaration's parameters should include:

```typescript
channel: {
  type: ["string", "null"],
  description: "Target channel for the triggered session output. Examples: 'cli:local', 'telegram-gateway'. Null uses the daemon's default channel.",
},
```

**Scheduler service update:** When `SchedulerService.performTick()` fires a schedule, it passes the `channel` to `launchTriggeredSchedule()`. The orchestrator uses this to determine which connection to bind the triggered session to.

**Default channel:** Configured in `config.yaml`:

```yaml
communication:
  type: websocket
  port: 8765
  default_channel: telegram-gateway  # NEW: where scheduled jobs deliver output by default
```

If `default_channel` is not configured and no channel is specified on the schedule, the triggered session runs but its `interact` calls queue until a matching connection is available. This matches the existing buffer behavior.

**LLM channel selection:** The system prompt should include guidance:

> "When creating schedules, consider the delivery channel. Time-sensitive notifications (reminders, alerts) should target always-on channels like 'telegram-gateway'. If the user doesn't specify a channel, use 'telegram-gateway' as the default for time-sensitive tasks and omit channel for work-related tasks."

The LLM chooses the channel when creating schedules. The user can override explicitly.

---

## 4. System Prompt Changes

**File:** `src/runtime/system-prompt.ts`

Add channel context to the system prompt:

```typescript
// New option:
channelId?: string;
activeSessionSummaries?: SessionSummary[];

// New section in prompt:
`Connected via channel: ${channelId}`,

// If Telegram channel (or any non-CLI channel):
channelId !== "cli:local"
  ? "You are connected via a remote channel. You cannot write files or execute commands. Use the sessions primitive to observe active coding sessions. Use memory to recall previous work. If the user needs code changes, suggest they do so from a CLI session."
  : null,

// Active sessions context:
activeSessionSummaries && activeSessionSummaries.length > 0
  ? `Other active sessions:\n${activeSessionSummaries.map(s => `- ${s.sessionId} (${s.channelId}, ${s.status}): ${s.taskSummary}`).join("\n")}`
  : null,
```

This gives the LLM awareness of its channel constraints and what else is running.

---

## 5. Data Model Changes

### 5.1 AgentSession

| Field | Type | Change |
|---|---|---|
| `channelId` | `string` | **New.** Set at construction, immutable. |
| `taskSummary` | `string` | **New.** Mutable, updated by runtime. Defaults to `""`. |

### 5.2 PrimitiveContext

| Field | Type | Change |
|---|---|---|
| `channelId` | `string` | **New.** Passed through from session to dispatcher. |

### 5.3 ScheduleRecord

| Field | Type | Change |
|---|---|---|
| `channel` | `string \| null` | **New.** Target delivery channel. Nullable. |

### 5.4 AgentConfig

| Field | Type | Change |
|---|---|---|
| `communication.default_channel` | `string \| undefined` | **New.** Default channel for scheduled job delivery. |

### 5.5 Database Migration

```sql
ALTER TABLE schedules ADD COLUMN channel TEXT;
```

---

## 6. Implementation Slices

Build in this order. Each slice is independently testable.

### Slice A: Multi-Connection WebSocket Server

**What:** Refactor `WebSocketCommunicationAdapter` to accept multiple connections with `identify` handshake.

**Files changed:**
- `src/communication/websocket.ts` — Major refactor. Connection registry, per-connection queues, identify protocol.
- `src/communication/adapter.ts` — No changes to the interface itself.

**Test:** Start daemon, connect two WebSocket clients, verify both stay connected and can send/receive independently. Verify that a second connection with the same `channelId` replaces the first.

**Does not change:** Nothing else in the system. The existing single-runtime wiring in `index.ts` continues to work with the first connection.

### Slice B: CommunicationRouter + SessionScopedAdapter

**What:** Build the router that maps connections to sessions and the adapter wrapper.

**Files changed/created:**
- `src/communication/router.ts` — New.
- `src/communication/session-scoped-adapter.ts` — New.

**Test:** Unit test the router's binding/unbinding, message routing, and disconnect handling.

### Slice C: SessionManager Multi-Session

**What:** Upgrade `SessionManager` to track multiple interactive sessions by channel. Add session metadata (`channelId`, `taskSummary`, `listActiveSessionSummaries`, `getSessionMessages`).

**Files changed:**
- `src/session/session.ts` — Add `channelId`, `taskSummary`, `updateTaskSummary()`.
- `src/session/manager.ts` — Replace `interactiveSessionId` with per-channel map. Add new query methods. Update cleanup.

**Test:** Create sessions for different channels, verify independent lifecycle. Verify `listActiveSessionSummaries` returns correct data.

### Slice D: PrimitiveContext channelId + Primitive Restrictions

**What:** Add `channelId` to `PrimitiveContext`. Add dispatch-level restriction check for `file_write` and `execute` on non-CLI channels.

**Files changed:**
- `src/primitives/types.ts` — Add `channelId` to `PrimitiveContext`.
- `src/primitives/dispatcher.ts` — Add restriction check in `dispatch()`.
- All call sites that create `PrimitiveContext` — Add `channelId` field.

**Test:** Dispatch `file_write` with `channelId: "telegram-gateway"`, verify it returns an error. Dispatch with `channelId: "cli:local"`, verify it succeeds.

### Slice E: `sessions` Primitive

**What:** Implement the `sessions` primitive with `list` and `read` operations.

**Files created:**
- `src/primitives/sessions.ts` — Handler implementation.

**Files changed:**
- `src/primitives/types.ts` — Add declaration (or keep in separate constant).
- `src/primitives/dispatcher.ts` — Register handler with `SessionManager` dependency.

**Test:** Create two sessions, call `sessions.list` from one, verify it sees the other. Call `sessions.read`, verify it returns sanitized messages.

### Slice F: Workspace Write Lock

**What:** Implement the workspace-level write lock and integrate with dispatch.

**Files created:**
- `src/runtime/workspace-lock.ts` — Lock implementation.

**Files changed:**
- `src/primitives/dispatcher.ts` — Acquire lock before `file_write`/`execute`.
- Session cleanup code — Release lock on session termination.

**Test:** Two sessions. First acquires lock via `file_write`. Second attempts `file_write`, gets blocked. First completes, second can now proceed.

### Slice G: RuntimeOrchestrator

**What:** Build the orchestrator that wires everything together for multi-session, multi-connection operation. Update `src/index.ts` to use it.

**Files created:**
- `src/runtime/orchestrator.ts` — Orchestrator implementation.

**Files changed:**
- `src/index.ts` — Replace direct wiring with orchestrator.
- `src/runtime/system-prompt.ts` — Add channel context to prompt.

**Test:** Start daemon, connect two WebSocket clients with different channelIds, send messages from both, verify independent sessions with correct primitive restrictions.

### Slice H: Schedule Channel Routing

**What:** Add `channel` field to schedules. Update scheduler to route triggered sessions to the correct connection.

**Files changed:**
- `src/scheduler/types.ts` — Add `channel` field.
- `src/scheduler/store.ts` — Schema migration, persist/read `channel`.
- `src/primitives/schedule.ts` — Accept `channel` parameter.
- `src/scheduler/service.ts` — Pass `channel` to orchestrator.
- Database migration.

**Test:** Create a schedule with `channel: "telegram-gateway"`. Verify triggered session binds to the telegram connection.

### Slice I: CLI `identify` Update

**What:** Update the CLI client to send an `identify` message on connect.

**Files changed:**
- `packages/cli/src/hooks/use-daemon.ts` — Send `{ type: "identify", channelId: "cli:local" }` after receiving `hello`.

**Test:** Start daemon with multi-connection support, connect CLI, verify it identifies and works as before.

### Slice J: Telegram Gateway

**What:** Build the Telegram gateway as a separate package.

**Files created:**
- `packages/telegram-gateway/` — Entire package.

**Test:** Start daemon + gateway. Send a message via Telegram. Verify daemon creates a session, responds, and the response appears in Telegram. Send "what's happening?" while a CLI session is active, verify observe mode works.

---

## 7. Key Decisions and Constraints

| Decision | Choice | Rationale |
|---|---|---|
| Gateway vs. native adapter | **Gateway (separate process)** | Keeps daemon minimal. Gateway is ~200 lines. Platform-specific code stays outside the daemon. |
| Observe mode implementation | **`sessions` primitive, not a special session type** | The LLM interprets the user's question and decides what to read. More flexible than a fixed status endpoint. |
| Workspace interference prevention | **Workspace-level write lock + system prompt convention** | Simple, sufficient for single-user. Per-file locking is deferred. |
| Multi-user Telegram | **Single-user for v1** | Whitelist one Telegram user ID. Multi-user adds auth complexity that isn't needed yet. |
| Stream chunks on Telegram | **Ignore for v1** | Telegram doesn't support streaming. Gateway waits for the final message. |
| Channel restriction enforcement | **Filtered tool declarations + dispatch-level check** | Two layers: LLM never sees restricted tools, and dispatch blocks them as a safety net. |
| Session-per-channel reuse | **Same as current CLI behavior, but per-channel** | Each channel gets one interactive session at a time, reused until expired. |
| Lock release on disconnect | **Lock held until session terminates** | Session may be mid-work. Releasing on disconnect would cause data loss if session continues with queued output. |

---

## 8. What Does NOT Change

The following components are intentionally unmodified:

- **`AgentRuntime` core loop** — `processSession()`, `collectProviderResponse()`, `dispatchToolCall()` are untouched. The runtime still processes one session; the orchestrator manages multiple runtimes.
- **`LLMProvider` / `OpenAICompatibleProvider`** — No changes.
- **`PolicyEngine`** — No changes. Channel restrictions are handled at the dispatcher level, not the policy level. The policy engine continues to operate on primitive/operation/path/domain matching as before.
- **`ToolSpecInterpreter`** — No changes.
- **`ToolSpecRegistry`** — No changes.
- **Existing primitives** (`http`, `file_read`, `file_write`, `execute`, `memory`, `schedule`, `interact`) — No behavioral changes. `schedule` gets one new parameter (`channel`). `PrimitiveContext` gets one new field (`channelId`).
- **CLI UI** (`packages/cli/`) — One small change: send `identify` on connect. All other CLI behavior is unchanged.

---

## 9. Scenario Validation

After implementation, validate against scenarios from `docs/scenarios.md`:

| Scenario | Channel | Validation |
|---|---|---|
| 5 (Water reminder) | Schedule fires → Telegram | Schedule created with `channel: "telegram-gateway"`. Triggered session sends notification via gateway. User sees reminder on phone. |
| 6 (Anniversary reminder) | Schedule fires → Telegram | Same as above. Multiple schedules in a group, all targeting Telegram. |
| 1 (Email triage) | Started from Telegram | User says "check my email" on Telegram. Agent uses `http` (Gmail spec) to read inbox, `memory` to store preferences, `interact` to present triage. No `file_write`/`execute` needed. Works fully on Telegram. |
| 3 (GitHub pushback) | Observe from Telegram | CLI session handles PR review. User walks away. From Telegram: "how's the PR review going?" → `sessions.list` → `sessions.read` → summary. |
| 4 (Issue to PR) | CLI, observe from Telegram | Heavy coding on CLI. User checks in from Telegram mid-flight. Observe mode shows progress. |
| Cross-channel | Telegram + CLI simultaneous | CLI session writes code. Telegram session asks "what's happening?" Both work independently. No interference. |

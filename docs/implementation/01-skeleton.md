# Slice 01: Skeleton

> **Goal:** A running daemon that accepts a WebSocket message, sends it to an LLM, and returns the response. The thinnest possible vertical slice through the entire architecture.

**Prerequisites:** None — this is the foundation.

**Architecture references:** docs/architecture.md — Process Model, Core Loop, Session Model, Communication Adapter Interface, LLM Interface

---

## What This Slice Delivers

A Bun TypeScript daemon that:
1. Reads a config file (`~/.agent/config.yaml`)
2. Starts a WebSocket server on a configurable port
3. Accepts a client connection
4. Receives a text message from the user
5. Creates a session with a system prompt
6. Streams the message to an LLM provider (OpenAI-compatible — works with OpenAI, Minimax, and any provider that implements the OpenAI chat completions API)
7. Streams the response back to the user over WebSocket
8. Handles the basic ReAct loop: if the model requests a tool call, the runtime acknowledges it (stub — no actual primitive execution yet)

This is NOT a useful agent yet. It is the skeleton that every subsequent slice builds on.

---

## Tasks

### Task 1.1: Project Setup
- Initialize Bun project: `bun init`
- Set up TypeScript config (`tsconfig.json`) with strict mode
- Create directory structure:
  ```
  src/
    index.ts              # daemon entry point
    config/
      loader.ts           # config file loading + validation
      schema.ts           # config type definitions
    session/
      manager.ts          # creates and tracks sessions
      session.ts          # single session state + message history
    llm/
      types.ts            # provider-agnostic types (InternalMessage, StreamChunk, ToolDeclaration)
      provider.ts         # LLMProvider interface
      openai.ts           # OpenAI-compatible adapter implementation (covers OpenAI, Minimax, etc.)
    communication/
      adapter.ts          # CommunicationAdapter interface
      websocket.ts        # WebSocket adapter implementation
    primitives/
      types.ts            # PrimitiveHandler type, PrimitiveResult interface
      dispatcher.ts       # routes primitive calls (stub implementations for now)
  ```
- Create default config file structure

### Task 1.2: Config Loading
- Define config schema:
  ```typescript
  interface AgentConfig {
    llm: {
      provider: 'openai'  // OpenAI-compatible (OpenAI, Minimax, Together, Groq, etc.)
      model: string
      base_url?: string   // defaults to https://api.openai.com/v1 — set for other providers
      context_limit: number
      max_output_tokens: number
      temperature: number
      api_key_env: string
    }
    communication: {
      type: 'websocket'
      port: number
    }
    agent_home: string  // defaults to ~/.agent
  }
  ```
- Load from `~/.agent/config.yaml` with sensible defaults
- Validate required fields (provider, model, api_key_env)
- Read API key from environment variable specified by `api_key_env`

### Task 1.3: WebSocket Communication Adapter
- Implement the 3-method CommunicationAdapter interface:
  ```typescript
  interface CommunicationAdapter {
    send(message: OutboundMessage): Promise<DeliveryResult>
    onMessage(handler: (message: InboundMessage) => void): void
    isConnected(): boolean
  }
  ```
- Use Bun's built-in WebSocket server (`Bun.serve` with WebSocket upgrade)
- Handle connection, disconnection, reconnection
- Buffer outbound messages when no client is connected, deliver on reconnect
- JSON message protocol over WebSocket:
  - Inbound: `{ type: "message", content: string }`
  - Outbound: `{ type: "message", content: string, actions?: Action[] }` and `{ type: "stream_chunk", content: string }` for streaming text

### Task 1.4: OpenAI-Compatible LLM Provider Adapter
- Implement the LLMProvider interface:
  ```typescript
  interface LLMProvider {
    stream(
      messages: InternalMessage[],
      tools: ToolDeclaration[],
      config: ModelConfig
    ): AsyncIterable<StreamChunk>
  }
  ```
- Install the `openai` npm package (`bun add openai`). The OpenAI SDK is a thin, well-typed client that handles SSE parsing and is the de facto standard for OpenAI-compatible providers. It is not a framework — it is a transport layer.
- Initialize the OpenAI client with `baseURL` from config (defaults to `https://api.openai.com/v1`) and `apiKey` from the resolved environment variable. This single client works for OpenAI, Minimax, Together, Groq, and any provider that implements the OpenAI chat completions API.
- Translate InternalMessage array to OpenAI's chat completion message format (`system`, `user`, `assistant`, `tool` roles)
- Translate ToolDeclaration array to OpenAI's tool/function schema format
- Use the SDK's streaming interface (`stream: true` on `chat.completions.create`) to get an async iterable of chunks
- Parse streaming chunks into StreamChunk objects:
  - `choices[0].delta.content` → text chunks
  - `choices[0].delta.tool_calls` → tool call chunks (accumulated by index)
  - `choices[0].finish_reason === 'tool_calls'` → signals tool calls are complete
- Handle API errors (auth failure, rate limiting, server errors) with clear error messages

### Task 1.5: Session Model
- Implement session creation and lifecycle:
  ```typescript
  interface Session {
    id: string
    status: 'active' | 'completed' | 'error'
    messages: InternalMessage[]
    createdAt: Date
    lastActivityAt: Date
    iterationCount: number
  }
  ```
- System prompt construction (hardcoded base prompt for now — no tool specs, no policy summary, no memory context yet)
- Message history management (append user messages, assistant messages, tool results)
- Iteration counting (max 50 per session)
- 10-minute inactivity timeout

### Task 1.6: Core Loop (ReAct Cycle)
- Wire everything together in the main loop:
  ```
  User message arrives via WebSocket
    → Session manager finds or creates session
    → Append user message to session history
    → Send session history + tools to LLM provider (streaming)
    → Accumulate stream chunks:
      - Text chunks → forward to user via WebSocket (streaming)
      - Tool call chunks → accumulate until complete
    → If tool calls present:
      - Dispatch to primitive dispatcher (stub: returns "not implemented yet")
      - Append tool results to session history
      - Loop back to LLM (next ReAct iteration)
    → If no tool calls (final response):
      - Session turn complete, await next user message
  ```
- The primitive dispatcher is a stub in this slice — it accepts any tool call and returns `{ success: false, error: "Primitive not implemented yet" }`. This lets us verify the ReAct loop works without needing real primitives.

### Task 1.7: Daemon Entry Point
- PID file management (write on start, check for existing, clean up on shutdown)
- Graceful shutdown on SIGINT/SIGTERM
- Console logging (structured JSON logging deferred to hardening slice)
- Start WebSocket server
- Print startup banner with port, model, and config path

---

## Definition of Done

All of the following must work:

1. `bun run src/index.ts` starts the daemon, prints startup info, writes PID file
2. A WebSocket client can connect to the configured port
3. Sending a text message results in a streamed response from the configured model appearing on the client
4. If the model tries to call a tool (e.g., if the system prompt mentions available tools), the runtime correctly detects the tool call, returns a stub error, and the model receives it and responds accordingly
5. Sending SIGINT gracefully shuts down the daemon and removes the PID file
6. Running the daemon twice (without stopping the first) fails with a "already running" error
7. Missing or invalid config produces a clear error message at startup
8. Missing API key environment variable produces a clear error at startup

## Testing Approach

### Manual Testing (primary for this slice)
- Start daemon, connect with `websocat` (WebSocket CLI tool) or a simple HTML page
- Send messages, verify streaming responses
- Kill and restart daemon, verify PID file behavior
- Test with missing config, bad API key, etc.

### Automated Tests
- **Config loader:** Unit tests for parsing valid config, handling missing fields, reading env vars
- **Session model:** Unit tests for message appending, iteration counting, timeout detection
- **OpenAI adapter:** Unit test with a mock HTTP server that returns OpenAI-format streaming SSE chunks — verify StreamChunk parsing
- **Core loop:** Integration test with a mock LLM provider — verify the full ReAct cycle (message → LLM → tool call stub → LLM → final response)
- **WebSocket adapter:** Integration test — start server, connect client, send/receive messages

### Test Commands
```bash
bun test                          # run all tests
bun test src/config/              # config tests only
bun test src/llm/                 # LLM adapter tests only
bun test src/session/             # session tests only
bun test --integration            # integration tests (require running daemon or mock server)
```

# agent-daemon

A local AI agent daemon built on a **Primitive Agent Architecture**. Instead of coding orchestration logic in framework code (LangChain, CrewAI, etc.), this project defines 7 universal primitives and lets the LLM handle routing. Higher-level tools are declarative JSON/YAML specs -- not code.

## Core thesis

Most "agent frameworks" operate at the wrong abstraction layer. Define a minimal set of universal primitives, let the model handle routing, and express tools as declarative specs rather than imperative code.

## The 7 Primitives

| Primitive | Purpose |
|-----------|---------|
| `http` | Network communication (REST/GraphQL API calls) |
| `file_read` | Read files and directories (read-only, safe) |
| `file_write` | Create and modify files (destructive, separated from read for security) |
| `execute` | Run shell commands in a sandboxed environment |
| `memory` | Persistent knowledge store (SQLite + FTS5, keyed + fuzzy search) |
| `schedule` | Time and event-based triggers (cron, one-shot, event-based) |
| `interact` | Human communication (notify, ask, approve modes) |

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Language:** TypeScript (strict mode)
- **LLM:** OpenAI-compatible API via the `openai` SDK
- **Config:** YAML
- **Testing:** Bun's built-in test runner
- **WebSocket:** Bun's built-in `Bun.serve`

## Prerequisites

- [Bun](https://bun.sh) v1.3.11+
- An OpenAI-compatible API key (OpenAI, Together, Groq, Minimax, etc.)

## Getting Started

### Install dependencies

```bash
bun install
```

### Create config file

Create `~/.agent/config.yaml`:

```yaml
llm:
  provider: openai
  model: gpt-4o-mini
  base_url: https://api.openai.com/v1
  context_limit: 128000
  max_output_tokens: 4096
  temperature: 0
  api_key_env: OPENAI_API_KEY

communication:
  type: websocket
  port: 8765
```

### Set your API key

```bash
export OPENAI_API_KEY="your-api-key-here"
```

The environment variable name is configurable via `llm.api_key_env` in the config.

### Run the daemon

```bash
bun run start
```

## Commands

| Command | Description |
|---------|-------------|
| `bun run start` | Start the agent daemon |
| `bun run dev` | Start with file watching (auto-restart on changes) |
| `bun run test` | Run all tests |
| `bun run typecheck` | TypeScript type checking |
| `bun run manual:ws "prompt"` | Manual WebSocket client for testing |

### Manual client options

The manual WebSocket client (`bun run manual:ws`) accepts environment variables:

- `AGENT_WS_URL` -- WebSocket URL (default: `ws://127.0.0.1:8765`)
- `AGENT_WS_IDLE_MS` -- Idle timeout in ms before auto-close (default: `1500`, `0` to disable)

## Project Structure

```
src/
  index.ts              # Daemon entry point, graceful shutdown
  config/               # YAML config loading + validation
  communication/        # WebSocket adapter (CommunicationAdapter interface)
  llm/                  # Provider-agnostic LLM types + OpenAI adapter
  session/              # Session management (timeouts, iteration limits)
  runtime/              # ReAct loop, tool dispatch, PID file management
  primitives/           # 7 primitive type declarations + dispatcher
  manual/               # Manual test client
docs/
  architecture.md       # Full architecture document
  tool-spec-format.md   # Declarative tool spec format v0.1
  implementation/       # Slice-by-slice implementation plans (01-07)
```

## Architecture Highlights

- **Minimal dependencies** -- only `openai` and `yaml` at runtime. The daemon relies on Bun built-ins for everything else (WebSocket server, SQLite, test runner).
- **Security by design** -- read/write primitives are separated, a Policy Layer enforces rules the agent cannot see or bypass, and a trust model governs tool specs.
- **Portable memory** -- the memory system uses a single SQLite file. Copy the file, copy the agent's knowledge.
- **Streaming** -- LLM responses stream over WebSocket to clients in real-time.
- **Single-client model** -- one active WebSocket connection at a time, with message queuing when disconnected.

## Current Status

**Slice 01 (Skeleton)** is complete:

- YAML config loading with validation
- WebSocket server for client communication
- Streaming LLM responses from OpenAI-compatible APIs
- Session management with inactivity timeout and iteration limits
- ReAct tool-call loop (primitives are stubbed)
- PID file management (prevents duplicate daemons)
- Graceful shutdown on SIGINT/SIGTERM

### Roadmap

| Slice | Name | Status |
|-------|------|--------|
| 01 | Skeleton | Done |
| 02 | Memory & File Primitives | Planned |
| 03 | Tool Spec Interpreter & HTTP | Planned |
| 04 | Policy Enforcement | Planned |
| 05 | Scheduling | Planned |
| 06 | Execute Primitive | Planned |
| 07 | Hardening | Planned |

See `docs/implementation/` for detailed plans for each slice.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | Core architecture, primitives, policy layer, memory & schedule design |
| [Tool Spec Format](docs/tool-spec-format.md) | Declarative JSON tool spec reference with full examples |
| [Stress Test Findings](docs/scenario-stress-test-findings.md) | 6 real-world scenario tests against the architecture |
| [Implementation Plans](docs/implementation/) | Detailed slice-by-slice build plans |

## License

Private -- not published.

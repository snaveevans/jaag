# Slice 09: Execute Sandbox — OS-Level Containment with Primitive Routing

> **Goal:** Make the Policy Engine's guarantees inescapable by sandboxing `execute` child processes at the OS level. Network calls from child processes are intercepted and routed through the same policy evaluation as direct `http` primitive calls. Filesystem access is restricted to policy-allowed paths.

**Prerequisites:** Slice 04 (Policy Enforcement), Slice 06 (Execute Primitive)

**Architecture references:** ADR-0006, docs/architecture.md — Policy Layer, Execute Primitive

**Target platform:** Linux (macOS development via Docker)

---

## Problem Statement

The `execute` primitive allows agents to run arbitrary shell commands. A child process inherits the host's network and filesystem access, which means it can bypass every policy rule defined for the `http`, `file_read`, and `file_write` primitives. The agent can write a Node.js script, a Python script, or use `curl` to make HTTP requests that the Policy Engine would normally block or require approval for.

This is not a theoretical concern. The bypass is trivial:

```bash
# Bypass http domain allowlist
execute("curl -X POST https://api.stripe.com/v1/charges -H 'Authorization: Bearer sk_live_xxx'")

# Bypass file_read path restrictions
execute("cat /etc/passwd")

# Bypass file_write restrictions  
execute("echo 'malicious' > /important/config/file")

# Obfuscated bypass (defeats string pattern matching)
execute("node -e \"require('https').request({hostname:'api.stripe.com',path:'/v1/charges',method:'POST'})\"")
```

String-level pattern matching cannot solve this. The solution must operate at the OS level.

---

## Architecture Overview

The sandbox consists of three components that work together:

```
┌─────────────────────────────────────────────────────────────────┐
│  Agent Daemon (Bun)                                             │
│                                                                  │
│  ┌────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │ http prim. │    │ file_read/write  │    │ execute prim.   │  │
│  └─────┬──────┘    └────────┬─────────┘    └────────┬────────┘  │
│        │                    │                        │           │
│        ▼                    ▼                        ▼           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    POLICY ENGINE                          │   │
│  └──────────────────────────────┬───────────────────────────┘   │
│                                 │                                │
└─────────────────────────────────┼────────────────────────────────┘
                                  │
                    ┌─────────────▼────────────────┐
                    │   SANDBOX HELPER (native)     │
                    │   Sets up:                    │
                    │   • Network namespace          │
                    │   • Bind mounts                │
                    │   • iptables redirect          │
                    │   • CA cert injection          │
                    │   • seccomp profile             │
                    │   • Environment sanitization    │
                    │   Then exec's the command       │
                    └─────────────┬────────────────┘
                                  │
          ┌───────────────────────┼─────────────────────────┐
          │   SANDBOXED NAMESPACE                            │
          │                                                  │
          │   ┌──────────────┐                               │
          │   │ Child Process │─── socket() ──┐              │
          │   │ (npm, curl,  │                │              │
          │   │  node, etc.) │                ▼              │
          │   └──────────────┘      ┌─────────────────┐     │
          │                         │ iptables REDIRECT│     │
          │                         └────────┬────────┘     │
          │                                  │              │
          └──────────────────────────────────┼──────────────┘
                                             │
                    ┌────────────────────────▼─────────────────┐
                    │   SANDBOX PROXY (Bun sidecar)             │
                    │                                           │
                    │   • TLS termination (local CA)             │
                    │   • Full HTTP request inspection           │
                    │   • Imports PolicyEngine directly          │
                    │   • allow/block: decided locally           │
                    │   • approve: IPC to daemon via Unix socket │
                    │   • Forwards allowed requests to real dest │
                    └───────────────────────────────────────────┘
```

### Component 1: Sandbox Helper (native binary)

A small compiled binary (or shell script) that sets up the Linux namespace and then `exec`s the target command inside it. The Bun runtime spawns this instead of the command directly.

### Component 2: Sandbox Proxy (Bun sidecar)

A long-running Bun process that acts as a transparent MITM HTTP/HTTPS proxy. It imports the `PolicyEngine` class directly, evaluates policy rules locally for `allow`/`block` decisions, and communicates with the daemon via Unix socket only for `approve` decisions and audit logging.

### Component 3: Execute Handler Changes

The existing `execute` primitive handler is modified to spawn commands through the sandbox helper instead of directly via `Bun.spawn`.

---

## Component 1: Sandbox Helper

### Purpose

Creates an isolated Linux namespace for the child process with:
- No direct network access (network namespace)
- Restricted filesystem view (mount namespace + bind mounts)
- Traffic redirected to the proxy (iptables)
- Trusted CA cert for MITM TLS (cert injection)
- Sanitized environment variables
- Restricted syscalls (seccomp-BPF)

### Implementation Language

**Bash script.** The helper is a linear sequence of ~80 lines calling `unshare`, `ip`, `mount`, and `iptables`. Shell is the right tool for this — no complex argument parsing, no concurrent state, no reason to introduce a compiled language. All required tools (`unshare`, `ip`, `iptables`, `mount`) are standard on Linux and available in the Docker dev container.

### Interface

```bash
# Invoked by the Bun execute handler
sandbox-exec \
  --proxy-addr 127.0.0.1:8443 \
  --proxy-http-addr 127.0.0.1:8080 \
  --ca-cert /path/to/sandbox-ca.pem \
  --workspace /path/to/workspace \
  --allowed-paths /usr,/bin,/lib,/lib64,/etc/alternatives \
  --read-only-paths /usr,/bin,/lib,/lib64,/etc/alternatives \
  --timeout 30 \
  --seccomp-profile /path/to/profile.json \
  -- npm test
```

### Namespace Setup Sequence

```
1. unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWPID)

2. Network namespace setup:
   a. Create veth pair: veth-sandbox <-> veth-host
   b. Move veth-host to the host network namespace
   c. Assign IP addresses:
      - veth-sandbox: 10.200.0.2/24
      - veth-host: 10.200.0.1/24
   d. Set default route: via 10.200.0.1
   e. Enable IP forwarding on host side

3. iptables inside sandbox namespace:
   a. -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port <proxy-https-port>
   b. -t nat -A OUTPUT -p tcp --dport 80  -j REDIRECT --to-port <proxy-http-port>
   c. -A OUTPUT -p tcp --dport <proxy-https-port> -j ACCEPT
   d. -A OUTPUT -p tcp --dport <proxy-http-port>  -j ACCEPT
   e. -A OUTPUT -p udp --dport 53 -j ACCEPT   # DNS — see DNS section
   f. -A OUTPUT -j DROP                         # Block all other outbound

4. Mount namespace setup:
   a. mount --make-rprivate /
   b. Create tmpfs at /tmp (private to sandbox)
   c. Bind mount workspace: --bind <host-workspace> /workspace
   d. Bind mount read-only system paths: --bind --ro /usr, /bin, /lib, etc.
   e. Optionally: mount empty tmpfs over sensitive paths to hide them

5. CA cert injection:
   a. Copy sandbox CA cert to /etc/ssl/certs/sandbox-ca.pem
   b. If /etc/ssl/certs/ca-certificates.crt exists, append CA cert to it
   c. Set environment: SSL_CERT_FILE, NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE

6. Environment setup:
   a. Start with clean environment
   b. Copy allowed variables (see Environment Policy section)
   c. Set proxy variables: HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy
   d. Set CA variables: NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE

7. Apply seccomp-BPF profile (see Seccomp section)

8. exec() the target command
```

### Environment Policy

**Default allowlist (always passed through):**

| Variable | Reason |
|----------|--------|
| `PATH` | Required for command resolution |
| `HOME` | Required by most tools |
| `USER` | Used by git, npm, etc. |
| `SHELL` | Used by some tools for subshell invocation |
| `TERM` | Terminal rendering |
| `LANG`, `LC_ALL`, `LC_*` | Locale |
| `EDITOR` | Used by git commit, etc. |
| `TZ` | Timezone |

**Always blocked (never passed through):**

Any variable matching these patterns is stripped:
- `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_CREDENTIAL`
- `OPENAI_*`, `ANTHROPIC_*`, `STRIPE_*` (common AI/payment providers)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
- `GITHUB_TOKEN`, `GH_TOKEN` (unless explicitly allowed by policy — see below)

**Policy-configurable env vars:**

The policy config supports an `execute.env` section:

```yaml
# In policy.yaml
execute:
  env:
    allow:
      - GITHUB_TOKEN    # Needed for git push
      - NPM_TOKEN       # Needed for npm publish
    block:
      - CUSTOM_SECRET   # Project-specific secret
```

This allows users to selectively pass credentials into the sandbox when specific commands legitimately need them (e.g., `git push` needs `GITHUB_TOKEN`). The default is deny-all for anything matching secret patterns.

The env allowlist is **global** (not per-command) for v1. Per-command (e.g., "pass `GITHUB_TOKEN` only when the command starts with `git`") adds complexity with marginal security benefit since the proxy is already catching network calls.

### Seccomp Profile

Start with a permissive profile based on Docker's default seccomp profile, blocking only the most dangerous syscalls:

**Blocked syscalls:**
- `kexec_load`, `kexec_file_load` — load a new kernel
- `reboot` — reboot the system
- `mount`, `umount`, `umount2` — modify mount points (sandbox helper already set them up)
- `pivot_root` — change root filesystem
- `swapon`, `swapoff` — swap management
- `ptrace` — process tracing (could be used to escape sandbox)
- `personality` — change execution domain
- `unshare` — create new namespaces (prevent nested escape)
- `setns` — join an existing namespace (prevent escape)
- `keyctl` — kernel key management
- `add_key`, `request_key` — key management

Everything else is allowed. This is a safety net, not the primary enforcement mechanism.

---

## Component 2: Sandbox Proxy

### Purpose

A transparent MITM HTTP/HTTPS proxy that:
1. Terminates TLS connections from sandboxed child processes
2. Inspects the full HTTP request (method, path, headers, body)
3. Evaluates the request against the Policy Engine
4. Forwards allowed requests to the real destination
5. Blocks or gates disallowed requests

### Architecture

The proxy runs as a separate Bun process, started by the daemon at startup and stopped at shutdown.

```
src/
  sandbox/
    proxy/
      index.ts          # Proxy entry point
      server.ts         # TCP/TLS listener and connection handler
      tls.ts            # Dynamic certificate generation
      policy-bridge.ts  # Policy evaluation (local) + daemon IPC (for approvals)
      protocol.ts       # IPC protocol types shared with daemon
    ca/
      manager.ts        # CA keypair generation and storage
    helper/
      sandbox-exec.sh   # Namespace setup script (prototype)
    config.ts           # Sandbox configuration types
    launcher.ts         # Start/stop proxy sidecar from daemon
```

### Proxy Lifecycle

```
Daemon starts
  → Ensure CA keypair exists (generate if first run)
  → Start proxy sidecar process (Bun subprocess)
  → Proxy loads PolicyEngine with same policy.yaml
  → Proxy opens Unix socket for IPC with daemon
  → Proxy listens on localhost:8443 (HTTPS) and localhost:8080 (HTTP)
  → Proxy signals ready to daemon

Execute primitive called
  → Daemon spawns sandbox-exec helper
  → Helper creates namespace, redirects traffic to proxy ports
  → Child process runs inside namespace
  → Child's HTTP/HTTPS traffic arrives at proxy
  → Proxy evaluates policy, forwards/blocks/gates
  → Child process completes
  → Sandbox namespace cleaned up

Daemon shuts down
  → Signal proxy to stop
  → Proxy closes listeners, exits
```

### TLS MITM Flow

```
1. Child process connects to proxy (iptables redirect, port 443 → 8443)
2. TLS ClientHello arrives at proxy
3. Proxy reads SNI hostname from ClientHello
4. Proxy generates a TLS certificate for that hostname:
   a. Check cert cache (in-memory, keyed by hostname)
   b. If miss: generate key pair, create cert signed by sandbox CA
   c. Cache the cert for future connections to same host
5. Proxy completes TLS handshake with child process using generated cert
6. Child process trusts it because sandbox CA is in its trust store
7. Proxy reads the decrypted HTTP request
8. Proxy evaluates policy (see Policy Evaluation section)
9. If allowed:
   a. Proxy opens TLS connection to real destination
   b. Proxy forwards the request
   c. Proxy pipes the response back to child process
10. If blocked:
    a. Proxy returns HTTP 403 Forbidden with policy reason
    b. Or: proxy RSTs the TCP connection (child sees ECONNRESET)
11. If approval required:
    a. Proxy sends approval request to daemon via IPC
    b. Proxy holds the connection open (with timeout)
    c. Daemon triggers interact(mode: approve) through normal flow
    d. Daemon sends approval result back via IPC
    e. Proxy forwards or blocks based on result
```

### Certificate Generation

```typescript
// src/sandbox/ca/manager.ts

interface CACertificate {
  cert: string;    // PEM-encoded certificate
  key: string;     // PEM-encoded private key
  certPath: string; // Path on disk
  keyPath: string;  // Path on disk
}

// On first run, generate a self-signed CA certificate
// Store in: ~/.agent/sandbox/ca/sandbox-ca.pem, sandbox-ca-key.pem
// CA validity: 10 years (local only, never leaves the machine)
// Use: node:crypto X509Certificate APIs or forge library

// Per-host certificate generation:
// - Generate a new RSA/EC key pair
// - Create a certificate with:
//   - Subject CN = hostname
//   - SAN: DNS:hostname
//   - Issuer: sandbox CA
//   - Validity: 24 hours (short-lived, cached in memory)
// - Sign with sandbox CA private key
// - Cache in Map<hostname, { cert, key, expiresAt }>
```

### Policy Evaluation in the Proxy

The proxy imports `PolicyEngine` directly:

```typescript
// src/sandbox/proxy/policy-bridge.ts

import { PolicyEngine } from "../../policy/engine.ts";
import { loadPolicy } from "../../policy/loader.ts";
import { PolicyRateLimiter } from "../../policy/rate-limiter.ts";
import type { PolicyEvaluationContext, PolicyDecision } from "../../policy/types.ts";

// The proxy creates its own PolicyEngine instance loaded from the same policy file.
// For allow/block decisions, evaluation is entirely local — no IPC.
// For approve decisions, the proxy must communicate with the daemon.
```

Policy context construction from intercepted HTTP request:

```typescript
function buildProxyPolicyContext(request: InterceptedRequest): PolicyEvaluationContext {
  return {
    primitive: "http",
    domain: request.hostname,
    path: request.path,
    method: request.method.toUpperCase(),
    // tool and trust_tier are not available for raw child process requests
    // These are only known for spec-based operations
    tool: undefined,
    trust_tier: undefined,
    operation: undefined,
  };
}
```

**Important:** Proxied requests will NOT have `tool`, `trust_tier`, or `operation` context. They are raw HTTP calls, not spec-mediated operations. Policy rules that match on these fields will not apply to proxied requests. This is correct behavior — a child process making a raw HTTP call should be evaluated as a raw HTTP call, not as a tool operation.

### IPC Protocol (Proxy ↔ Daemon)

Communication over a Unix domain socket at `~/.agent/sandbox/proxy.sock`.

```typescript
// src/sandbox/proxy/protocol.ts

// Proxy → Daemon
interface ApprovalRequest {
  type: "approval_request";
  requestId: string;
  context: {
    method: string;
    domain: string;
    path: string;
    source: "sandbox_proxy";  // Distinguishes from direct primitive calls
    executeCommand?: string;  // The original execute command that spawned this process
  };
}

// Daemon → Proxy
interface ApprovalResponse {
  type: "approval_response";
  requestId: string;
  approved: boolean;
  reason?: string;
}

// Proxy → Daemon (fire-and-forget)
interface AuditEvent {
  type: "audit";
  timestamp: string;
  method: string;
  domain: string;
  path: string;
  decision: "allow" | "block" | "approve_granted" | "approve_denied";
  rule_id?: string;
}
```

### Approval Flow Timeout

When the proxy intercepts a request that requires approval:

1. The proxy sends an `ApprovalRequest` to the daemon via IPC.
2. The daemon triggers `interact(mode: approve)` through the normal WebSocket flow.
3. The user sees: `"[Sandbox] Child process (npm test) wants to POST https://api.stripe.com/v1/charges. Allow?"`
4. The proxy holds the child's TCP connection open while waiting.

**The timeout question:** How long does the proxy wait before giving up?

- If the child process has its own timeout (e.g., `curl --max-time 30`), it will close the connection on its side.
- If the child process is patient (e.g., `node` with no timeout), the proxy needs its own ceiling.

**Recommendation:** 120 seconds. After that, the proxy returns HTTP 504 Gateway Timeout to the child process and logs the timeout. This gives users reasonable time to respond while preventing indefinite connection holds.

This is configurable:

```yaml
# In config.yaml or policy.yaml
sandbox:
  approval_timeout_seconds: 120
```

### HTTP (non-TLS) Handling

Not all child process traffic is HTTPS. Some may be plain HTTP (port 80).

- The proxy listens on a separate port for HTTP (e.g., 8080)
- iptables redirects port 80 traffic to the HTTP listener
- No TLS termination needed — the proxy reads the HTTP request directly
- Same policy evaluation applies
- Same approval/block/allow flow

### Non-HTTP Protocol Handling

Child processes may attempt non-HTTP connections. **All non-HTTP protocols are blocked by default.**

| Protocol | Port | Example | Handling |
|----------|------|---------|----------|
| SSH | 22 | `git push` over SSH | **Blocked.** Force HTTPS via `git config --global url."https://".insteadOf "git@"` |
| DNS | 53 | Domain resolution | **Allowed** to system resolver (see DNS section) |
| SMTP | 25/587 | Sending email | **Blocked** |
| Database | 3306/5432 | MySQL/PostgreSQL | **Blocked** |
| Raw TCP | any | Custom protocols | **Blocked** |

Git SSH is forced to HTTPS inside the sandbox, keeping the proxy as the single enforcement point. The sandbox helper sets `git config --global url."https://".insteadOf "git@"` in the sandboxed environment.

### DNS Resolution

DNS is allowed to the system resolver. The sandbox iptables allow UDP port 53 to the host's configured DNS server (e.g., 127.0.0.53 for systemd-resolved or 8.8.8.8). The child process can resolve domains, but the actual HTTP connection goes through the proxy for policy evaluation. DNS exfiltration is a sophisticated attack with low bandwidth — the proxy catches the real connection regardless of how the domain was resolved.

A DNS proxy with domain allowlisting is a potential future enhancement if DNS exfiltration becomes a concrete concern.

---

## Component 3: Execute Handler Changes

### Current Handler (Slice 06)

The current `execute` handler spawns commands directly via `Bun.spawn` with environment sanitization and timeout enforcement.

### Modified Handler

```typescript
// Pseudocode for the modified execute handler

async function executeHandler(params, context): Promise<PrimitiveResult> {
  const command = params.command;
  const timeout = params.timeout ?? 30;

  if (!sandboxEnabled()) {
    // Development mode: behave exactly as current Slice 06 implementation
    return await directExecute(command, timeout, context);
  }

  // Production mode: spawn through sandbox helper
  const result = await sandboxExecute({
    command,
    timeout,
    proxyAddr: getSandboxProxyAddr(),
    caCertPath: getSandboxCACertPath(),
    workspaceDir: getWorkspaceDir(),
    allowedPaths: computeAllowedPaths(),   // From policy
    readOnlyPaths: computeReadOnlyPaths(), // From policy
    env: computeSandboxEnv(),              // Sanitized + policy-allowed
    seccompProfile: getSeccompProfilePath(),
  });

  return {
    success: result.exitCode === 0,
    data: {
      exitCode: result.exitCode,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
    },
  };
}
```

### Execute Primitive API

**No changes to the agent-facing API.** The `execute` primitive call looks identical:

```json
{
  "primitive": "execute",
  "command": "npm test"
}
```

The sandbox is transparent. The agent does not know it's sandboxed and cannot request sandbox configuration. All sandbox parameters come from the policy and daemon configuration.

**Rationale:** If the agent could control sandbox parameters, it could weaken its own containment. The sandbox is part of the Policy Layer — invisible to the agent, enforced by the runtime.

---

## Configuration

### Daemon Configuration (`config.yaml`)

```yaml
sandbox:
  enabled: true                     # false for development mode
  proxy:
    https_port: 8443                # Proxy HTTPS listen port
    http_port: 8080                 # Proxy HTTP listen port
    ipc_socket: ~/.agent/sandbox/proxy.sock
  ca:
    dir: ~/.agent/sandbox/ca        # CA certificate storage
  helper:
    path: ~/.agent/sandbox/sandbox-exec  # Path to sandbox helper binary/script
  network:
    subnet: 10.200.0.0/24          # Sandbox network subnet
    host_ip: 10.200.0.1            # Host side of veth pair
    sandbox_ip: 10.200.0.2         # Sandbox side of veth pair
  defaults:
    timeout_seconds: 30            # Default command timeout
    approval_timeout_seconds: 120  # How long proxy waits for user approval
```

### Policy Configuration (`policy.yaml` extensions)

```yaml
# Existing policy rules apply to proxied requests too.
# These rules already work for the proxy because it constructs
# the same PolicyEvaluationContext as the http primitive:

rules:
  # This rule blocks Stripe for both direct http primitive calls
  # AND child process HTTP calls going through the proxy
  - id: block-stripe
    primitive: http
    action: block
    match:
      domain: ["api.stripe.com"]

  # This rule requires approval for any POST, whether from the
  # agent directly or from a sandboxed child process
  - id: approve-posts
    primitive: http
    action: approve
    match:
      method: ["POST", "PUT", "PATCH", "DELETE"]

# New: execute-specific policy extensions
execute:
  env:
    allow: []        # Additional env vars to pass into sandbox
    block: []        # Additional env vars to explicitly block
  
  # Proxied requests from sandboxed child processes use the same policy rules
  # as direct http primitive calls. No trigger_source-aware differentiation for v1.
  # The audit data already tracks source ("sandbox_proxy"), so threading it through
  # to policy evaluation is a small change if a concrete need arises later.
```

---

## Development Workflow (macOS via Docker)

### Docker Setup

```dockerfile
# Dockerfile.dev
FROM oven/bun:latest

# Install sandbox dependencies
RUN apt-get update && apt-get install -y \
  iproute2 \
  iptables \
  fuse3 \
  libfuse3-dev \
  # For CA cert management
  ca-certificates \
  openssl \
  && rm -rf /var/lib/apt/lists/*

# Working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./
RUN bun install

# Source is volume-mounted for development
```

```yaml
# docker-compose.dev.yaml
services:
  agent:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app              # Source code mount for hot reload
      - agent-home:/root/.agent  # Persist agent home
    cap_add:
      - SYS_ADMIN           # Required for namespaces
      - NET_ADMIN            # Required for iptables, network namespaces
    devices:
      - /dev/fuse            # Required for future FUSE support
    security_opt:
      - apparmor:unconfined  # Required for nested namespaces
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    ports:
      - "8765:8765"          # WebSocket port
    command: bun --watch src/index.ts

volumes:
  agent-home:
```

### Execution Modes

```typescript
// src/sandbox/config.ts

type SandboxMode = "disabled" | "enabled";

function getSandboxMode(): SandboxMode {
  // Explicit config takes precedence
  if (config.sandbox?.enabled === false) return "disabled";
  if (config.sandbox?.enabled === true) return "enabled";

  // Auto-detect: enable if Linux namespace support is available
  if (process.platform === "linux" && canCreateNamespaces()) return "enabled";

  // Default to disabled (macOS without Docker, or missing capabilities)
  return "disabled";
}
```

When `sandbox.enabled = false`, the execute handler behaves exactly as the current Slice 06 implementation. The proxy sidecar is not started. No namespace setup occurs.

---

## Filesystem Isolation: Bind Mounts → FUSE Upgrade Path

### Phase 1: Bind Mounts (This Slice)

The sandbox helper creates a restricted filesystem view using bind mounts:

```
Sandbox view:
  /workspace/     → bind mount from host workspace (read-write)
  /tmp/           → private tmpfs (sandbox-local)
  /usr/           → bind mount from host (read-only)
  /bin/           → bind mount from host (read-only)
  /lib/           → bind mount from host (read-only)
  /lib64/         → bind mount from host (read-only)
  /etc/ssl/       → bind mount from host + injected CA (read-only)
  /etc/resolv.conf → bind mount from host (read-only, for DNS)
  Everything else → not mounted, invisible
```

**Granularity:** Directory-level. Can control "workspace is visible" but cannot control "this file inside workspace is blocked."

### Phase 2: FUSE Overlay (Future Slice)

When finer-grained control is needed:

```
Sandbox view:
  /workspace/     → FUSE mount (backed by host workspace)
                    Every open/read/write goes through policy engine
  /tmp/           → private tmpfs
  /usr/, /bin/, etc. → bind mount from host (read-only)
```

**Upgrade path is clean because:**
1. The policy evaluation interface (`canRead(path)`, `canWrite(path)`) is defined in Phase 1 even though bind mounts only use it at setup time.
2. Phase 2 replaces the bind mount with a FUSE mount that calls the same interface on every operation.
3. Nothing else changes — the proxy, the namespace setup, the seccomp profile all stay the same.
4. The child process sees the same filesystem structure.

**Interface to design now (used by bind mount setup, reused by FUSE later):**

```typescript
// src/sandbox/filesystem/policy.ts

interface FilesystemSandboxPolicy {
  /** Determines if a path should be visible in the sandbox */
  isPathVisible(absolutePath: string): boolean;

  /** Determines if a path should be writable (vs read-only) */
  isPathWritable(absolutePath: string): boolean;

  /** Returns the list of paths to bind-mount and their permissions */
  computeMountPlan(): MountEntry[];
}

interface MountEntry {
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}
```

---

## Concurrent Execution

Multiple `execute` calls may run simultaneously. **Each `execute` gets its own namespace, all sharing the same proxy instance.**

The proxy is stateless per-request, so sharing is safe. The namespaces provide isolation between concurrent commands. The proxy handles concurrent connections naturally (it's just a TCP server).

The namespace setup needs unique identifiers:
- Each sandbox gets a unique veth pair name: `veth-sb-{short-uuid}`
- Each sandbox gets a unique IP from the subnet: `10.200.0.{2+n}/24`
- The proxy doesn't need to change — it handles whatever connections arrive

---

## Audit and Logging

### What Gets Logged

Every HTTP request intercepted by the proxy is logged as an audit event:

```typescript
interface SandboxAuditEntry {
  timestamp: string;
  source: "sandbox_proxy";
  executeCommand: string;     // The original execute command
  sessionId: string;          // The agent session that triggered execute
  method: string;
  url: string;
  domain: string;
  path: string;
  decision: "allow" | "block" | "approve_granted" | "approve_denied" | "timeout";
  ruleId?: string;            // Which policy rule matched
  latencyMs: number;          // Time to evaluate + forward
}
```

### Where It Goes

Audit events are sent to the daemon via IPC and logged through the daemon's standard `Logger` class. Unified logging — one stream. The proxy sends audit events over the IPC socket as fire-and-forget messages. The daemon logs them with the session context.

### Session History

Only **policy-notable events** (blocks and approvals) are surfaced to the model, appended to the `execute` result. Routine allowed traffic is invisible to the model but logged for audit. The LLM doesn't need to know that `npm install` made 200 HTTP calls to registry.npmjs.org — the execute result (stdout/stderr) is sufficient. But if a child process triggered an approval or was blocked, that's relevant context for the model.

---

## Testing Strategy

### Unit Tests

| Test | What It Validates |
|------|-------------------|
| CA certificate generation | Generates valid CA, generates valid per-host certs, certs are signed by CA |
| Policy evaluation in proxy | Proxy constructs correct `PolicyEvaluationContext` from intercepted HTTP request |
| IPC protocol serialization | Messages serialize/deserialize correctly over Unix socket |
| Environment sanitization | Secret env vars are stripped, allowed vars are preserved |
| Mount plan computation | `FilesystemSandboxPolicy` produces correct mount entries from policy config |

### Integration Tests (Require Docker/Linux)

| Test | What It Validates |
|------|-------------------|
| `execute("curl https://allowed.com")` succeeds | Proxy forwards allowed requests |
| `execute("curl -X POST https://blocked.com")` fails | Proxy blocks per policy rules |
| `execute("curl -X POST https://approval-required.com")` triggers approval | Proxy IPC → daemon → interact flow works end-to-end |
| `execute("env")` output has no secrets | Environment sanitization works inside namespace |
| `execute("ls /etc/passwd")` fails | Bind mount isolation works |
| `execute("ls /workspace")` succeeds | Workspace is accessible |
| `execute("npm install")` works | Real-world tool works through proxy |
| `execute("git push")` works | Git over HTTPS works through proxy |
| Two concurrent `execute` calls don't interfere | Namespace isolation between concurrent commands |
| Proxy cert cache works | Second connection to same host reuses cached cert |
| Proxy handles child process timeout | Child killed after timeout, proxy cleans up |

### Test Commands

```bash
bun test src/sandbox/         # Unit tests (run anywhere)
bun test --integration        # Integration tests (require Docker/Linux)
```

---

## Resolved Questions Summary

| # | Question | Decision |
|---|----------|----------|
| 1 | Sandbox helper: shell script or compiled binary? | **Bash script.** Shell is the right tool for a linear sequence of `unshare`/`ip`/`mount`/`iptables` commands. Revisit only if integration testing reveals fragility. |
| 2 | Execute env policy: per-command or global allowlist? | **Global for v1.** Proxy already catches network calls, so per-command env granularity is premature. |
| 3 | Non-HTTP protocols: block all or selective allow? | **Block all non-HTTP. Force git to HTTPS** via `git config --global url."https://".insteadOf "git@"`. Single enforcement point. |
| 4 | DNS handling: allow system resolver or DNS proxy? | **Allow system resolver.** DNS exfiltration is sophisticated and low-bandwidth. Proxy catches the real connection regardless. |
| 5 | Approval timeout: how long does proxy wait? | **120 seconds, configurable** via `sandbox.approval_timeout_seconds`. |
| 6 | Concurrent execution: shared or per-execution sandbox? | **Shared proxy, per-execution namespace.** Proxy is stateless per-request. Namespaces isolate concurrent commands. |
| 7 | Audit logging destination | **Unified through daemon logger via IPC.** One log stream. |
| 8 | Session history: surface proxied requests to model? | **Only blocked/approved events.** Routine allowed traffic is invisible to the model but logged for audit. |
| 9 | Execute-specific policy rules (stricter in sandbox context)? | **Same rules as direct `http` for v1.** No `trigger_source` concept yet. The audit data already tracks source — thread it through to policy evaluation when a concrete need arises. |
| 10 | FUSE timeline: when to implement Phase 2? | **After v1 is validated, only if bind mounts prove insufficient.** Concrete trigger: needing to block specific files (e.g., `.env`) within an allowed directory. `FilesystemSandboxPolicy` interface is already designed to support both. |

---

## Implementation Order

| Step | Component | Dependencies | Effort |
|------|-----------|-------------|--------|
| 9.1 | CA manager (generate/load CA keypair) | None | Small |
| 9.2 | Dynamic cert generation (per-host certs) | 9.1 | Small |
| 9.3 | IPC protocol types + Unix socket server/client | None | Small |
| 9.4 | Proxy server (HTTP + HTTPS listeners, MITM flow) | 9.1, 9.2 | Large |
| 9.5 | Policy bridge (proxy imports PolicyEngine, IPC for approvals) | 9.3, 9.4 | Medium |
| 9.6 | Proxy launcher (daemon starts/stops proxy sidecar) | 9.4, 9.5 | Small |
| 9.7 | Sandbox helper script (namespace + mount + iptables + env) | 9.1 | Medium |
| 9.8 | Execute handler integration (spawn through sandbox helper) | 9.6, 9.7 | Medium |
| 9.9 | Filesystem sandbox policy interface | None | Small |
| 9.10 | Docker development setup | None | Small |
| 9.11 | Integration tests | 9.1–9.10 | Medium |
| 9.12 | Audit logging integration | 9.3, 9.5, 9.6 | Small |

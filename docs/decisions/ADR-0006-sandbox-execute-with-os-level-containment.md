---
status: "accepted"
date: 2026-03-28
decision-makers:
  - Tyler
consulted:
  - Claude (brainstorm session)
informed: []
---

# Sandbox execute primitive with OS-level containment and primitive routing

## Context and Problem Statement

The Policy Engine enforces rules the agent cannot see or bypass — for direct primitive calls. But the `execute` primitive is an escape hatch that nullifies this enforcement. A child process spawned by `execute` can make arbitrary HTTP requests (bypassing the `http` primitive's domain allowlists and approval gates), read any file on the host (bypassing `file_read` path restrictions), and write anywhere (bypassing `file_write` restrictions).

The current `execute` implementation (Slice 06) performs best-effort command pattern matching and environment sanitization, but these are explicitly "not a security boundary." An agent can trivially circumvent string-level checks by writing a script to a file and executing it, base64-encoding payloads, or using any language runtime installed on the host.

**The fundamental problem:** The Policy Engine and `execute`'s child processes run at the same privilege level. The policy engine has no jurisdiction over what a child process does after it's spawned. Safety enforcement must live at an OS layer the child process cannot escape.

**The question:** How do we make the `execute` primitive safe enough that the Policy Engine's guarantees hold even when the agent spawns arbitrary child processes?

## Decision Drivers

* The Policy Engine's guarantees must hold regardless of what `execute` runs — pattern matching is insufficient
* Child process network calls should go through the same policy evaluation as direct `http` primitive calls, including approval gates
* Child process file access should respect the same restrictions as `file_read` and `file_write` primitives
* The sandbox must be transparent to child processes — they should not need modification to run inside it
* TypeScript/Bun should be used where possible to maximize policy engine code reuse
* The solution must run on Linux and be developable on macOS via Docker
* Performance overhead must be acceptable for common developer workflows (test suites, builds, git operations)

## Considered Options

* Sandbox child processes using Linux namespaces with a MITM HTTP proxy that routes network calls through the policy engine, and bind mounts for filesystem isolation
* Block all network access in `execute` and require the agent to use the `http` primitive directly for any network needs
* Use an existing container runtime (Docker, gVisor, Firecracker) to run each `execute` command
* Improve command string pattern matching with more sophisticated analysis (AST parsing, static analysis)

## Decision Outcome

Chosen option: "Sandbox child processes using Linux namespaces with a MITM HTTP proxy that routes network calls through the policy engine, and bind mounts for filesystem isolation", because it closes the escape hatch while preserving `execute`'s utility for legitimate development workflows. Network calls from child processes are routed through the same policy rules as direct `http` primitive calls, and filesystem access is restricted to policy-allowed paths. The sandbox is transparent to child processes, and TypeScript/Bun is used for the proxy sidecar to maximize code reuse with the policy engine.

### Consequences

* Good, because the Policy Engine's guarantees now hold for all agent actions, including anything spawned by `execute`.
* Good, because child processes can still perform legitimate network operations (npm install, git push) — they just go through policy evaluation first.
* Good, because the MITM proxy provides full HTTP request visibility (method, path, headers, body), enabling the same granularity of policy enforcement as direct `http` primitive calls.
* Good, because the proxy sidecar shares the PolicyEngine implementation, so policy rules are evaluated identically regardless of whether a call comes from the agent directly or from a child process.
* Good, because the bind-mount filesystem isolation has a clean upgrade path to FUSE for per-file policy enforcement.
* Bad, because the MITM proxy adds latency to every HTTPS connection from child processes (TLS termination + re-encryption).
* Bad, because the sandbox requires Linux kernel features (namespaces, iptables), adding a Docker dependency for macOS development.
* Bad, because a native sandbox helper binary is needed for namespace setup, adding a compiled component to an otherwise pure TypeScript project.
* Bad, because some tools with TLS certificate pinning will fail inside the sandbox, though this is rare for CLI tools.

### Confirmation

This decision is confirmed if:
1. A child process running `curl -X POST https://api.stripe.com/v1/charges` inside `execute` triggers the same policy evaluation (and approval gate) as a direct `http` primitive POST to the same URL.
2. A child process cannot read files outside the policy-allowed paths.
3. A child process cannot access host environment variables containing API keys or secrets.
4. Common developer workflows (`npm test`, `npm install`, `git push`) work correctly through the sandbox with acceptable latency.
5. The proxy sidecar imports and uses the same `PolicyEngine` class as the main daemon.

## Pros and Cons of the Options

### Sandbox with MITM proxy and bind mounts

This is the chosen option.

* Good, because it makes the policy engine's enforcement inescapable — enforcement moves to the OS layer.
* Good, because it's transparent to child processes — no modifications needed to existing tools.
* Good, because the MITM proxy provides verb/path/body visibility for full policy evaluation.
* Good, because the proxy sidecar runs as a TypeScript/Bun process, sharing the PolicyEngine code directly.
* Neutral, because a native helper binary is needed for namespace setup, but this is a thin wrapper.
* Bad, because MITM TLS adds ~2-5ms latency per HTTPS connection from child processes.
* Bad, because tools with TLS certificate pinning will fail (rare in CLI tools, correct security behavior).
* Bad, because Linux namespaces require privileged container setup on macOS.

### Block all network access in execute

This is the simplest approach.

* Good, because it's trivially simple — no proxy, no TLS, no MITM.
* Good, because it eliminates the network escape hatch completely.
* Bad, because `npm install`, `git push`, `pip install`, and any command that fetches dependencies stops working.
* Bad, because it forces the agent into awkward workflows: "use `http` to download the file, use `file_write` to save it, then `execute` to use it."
* Bad, because it makes `execute` far less useful for real-world development scenarios.

### Use an existing container runtime (Docker, gVisor, Firecracker)

This leverages battle-tested isolation.

* Good, because container runtimes provide strong, well-audited isolation.
* Good, because gVisor specifically intercepts syscalls and could map them to primitives.
* Neutral, because it provides more isolation than needed — we don't need full container semantics.
* Bad, because it adds a heavy runtime dependency (Docker daemon, gVisor kernel).
* Bad, because startup latency for a new container per `execute` call is significant (100ms-2s).
* Bad, because it makes the development workflow more complex.
* Bad, because policy integration requires a custom bridge regardless — the container runtime doesn't know about our policy rules.

### Improve command string pattern matching

This is the current approach, enhanced.

* Good, because it requires no architectural changes.
* Neutral, because more sophisticated analysis (AST parsing) catches more cases.
* Bad, because it is fundamentally a cat-and-mouse game — any string-level analysis can be bypassed by obfuscation, indirection, or dynamic code generation.
* Bad, because it provides a false sense of security.
* Bad, because the architecture doc already acknowledges this is "not a security boundary."

## More Information

This ADR extends ADR-0003 (enforce safety outside agent-controlled specs) to cover the `execute` primitive bypass. The implementation spec is in `docs/implementation/09-execute-sandbox.md`. The existing execute primitive implementation (Slice 06) continues to provide environment sanitization and timeout enforcement within the sandbox.

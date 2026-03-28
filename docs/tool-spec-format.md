# Tool Spec Format v0.1

> **Purpose:** A declarative JSON format for describing external tools so that an AI agent can read the spec, understand the interface, and execute operations using the 7 primitives — without any hand-coded integration logic.

Related ADRs:
- `docs/decisions/ADR-0002-describe-tools-declaratively-and-handle-auth-as-runtime-middleware.md`
- `docs/decisions/ADR-0003-enforce-safety-outside-agent-controlled-specs.md`
- `docs/decisions/ADR-0004-use-sqlite-fts5-memory-with-keyed-and-fuzzy-access.md`

---

## Design Principles

1. **The model is the primary reader.** Every field includes a human-readable `description`. The spec must make sense to an AI model reading it cold with no prior knowledge of the tool.

2. **The runtime is the secondary reader.** The spec must be machine-parseable enough that a runtime can construct valid HTTP requests, inject auth, handle pagination, and interpret errors — all from the spec alone.

3. **Auth is middleware, not an operation.** The auth section describes *how* to authenticate. The runtime handles the lifecycle (check token → refresh → re-authorize). Individual operations never think about auth.

4. **Flat operation IDs, grouped by resource.** Operations have unique IDs (`issues.get`, `pulls.create`) but are organized under resource groups for navigability. The model can scan resource groups to find relevant operations quickly.

5. **Responses are described, not exhaustively typed.** The spec highlights the fields the model is most likely to need. It does not attempt to replicate full API documentation — just enough for the model to use the response in subsequent steps.

6. **Errors include recovery instructions.** When a specific error occurs, the spec tells the model what it means and what to do about it, in natural language.

---

## Spec Structure

### Top Level

```json
{
  "spec_version": "0.1",
  "tool": "<unique_tool_id>",
  "name": "<human_readable_name>",
  "description": "<what this tool does and when to use it>",
  "docs_url": "<link to full API documentation, optional>",

  "auth": { },
  "connection": { },
  "memory_keys": { },
  "resources": { }
}
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `spec_version` | string | yes | Format version. Allows spec evolution without breaking older specs. |
| `tool` | string | yes | Unique identifier. Lowercase, no spaces. Used for referencing in memory and logs. e.g., `"github"`, `"gmail"`, `"stripe"` |
| `name` | string | yes | Display name. e.g., `"GitHub"`, `"Gmail"`, `"Stripe"` |
| `description` | string | yes | Natural language description for the model. Should explain what the tool does and when to choose it over alternatives. |
| `docs_url` | string | no | Link to full API docs. The model can use this as a fallback if the spec doesn't cover an edge case. |
| `auth` | object | yes | Authentication configuration. See Auth Section. |
| `connection` | object | yes | Base URL, default headers, rate limits. See Connection Section. |
| `memory_keys` | object | no | Keyed memory slots this tool will use. Keys are short identifiers; the runtime auto-prefixes them with the tool ID to guarantee global uniqueness. See Memory Keys Section. |
| `resources` | object | yes | Grouped operations. See Resources Section. |

---

### Auth Section

Auth describes how to authenticate with the tool. The runtime reads this and handles the entire credential lifecycle automatically.

#### Type: `none`

```json
{
  "auth": {
    "type": "none",
    "description": "Public API — no authentication required"
  }
}
```

#### Type: `api_key`

```json
{
  "auth": {
    "type": "api_key",
    "description": "Authenticate with a static API key",
    "location": "header",
    "key_name": "X-API-Key",
    "env_var": "WEATHER_API_KEY"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `location` | `"header"` or `"query"` | yes | Where the key goes — HTTP header or query parameter |
| `key_name` | string | yes | Header name or query param name |
| `env_var` | string | yes | Environment variable holding the key value. Never hardcode secrets in specs. |

#### Type: `bearer_token`

```json
{
  "auth": {
    "type": "bearer_token",
    "description": "Authenticate with a static bearer token in the Authorization header",
    "env_var": "GITHUB_TOKEN"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `env_var` | string | yes | Environment variable holding the token. Injected as `Authorization: Bearer <token>`. |

#### Type: `basic`

```json
{
  "auth": {
    "type": "basic",
    "description": "HTTP Basic authentication",
    "username_env": "JIRA_USERNAME",
    "password_env": "JIRA_API_TOKEN"
  }
}
```

#### Type: `oauth2`

This is the complex case. The spec describes the OAuth2 flow parameters. The runtime handles the full lifecycle.

```json
{
  "auth": {
    "type": "oauth2",
    "description": "OAuth 2.0 Authorization Code flow with PKCE",
    "flow": "authorization_code",
    "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_url": "https://oauth2.googleapis.com/token",
    "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    "credentials": {
      "client_id_env": "GOOGLE_CLIENT_ID",
      "client_secret_env": "GOOGLE_CLIENT_SECRET"
    },
    "pkce": true,
    "token_storage_key": "tokens"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `flow` | `"authorization_code"` or `"client_credentials"` | yes | Which OAuth2 grant type |
| `authorization_url` | string | for auth_code | Where to send the user to authorize |
| `token_url` | string | yes | Endpoint to exchange code for tokens / refresh tokens |
| `scopes` | string[] | yes | Permissions to request |
| `credentials` | object | yes | Env vars for client ID and secret |
| `pkce` | boolean | no | Whether to use PKCE (recommended for all new integrations) |
| `token_storage_key` | string | yes | Short key name for token storage. Runtime auto-derives the full key as `oauth:{tool_id}:{token_storage_key}`. e.g., `"tokens"` for a tool with ID `"gmail"` becomes `oauth:gmail:tokens`. |

#### Auth Middleware Behavior (Runtime)

The runtime handles auth automatically for every `http` call to a tool. The agent never explicitly manages tokens. Here is the decision flow:

```
Before every HTTP request:
│
├─ auth.type == "none" → send request as-is
├─ auth.type == "api_key" → inject key from env_var into header/query
├─ auth.type == "bearer_token" → inject Authorization header from env_var
├─ auth.type == "basic" → inject Authorization header (base64 encoded)
├─ auth.type == "oauth2" →
│   │
│   ├─ memory.get(oauth:{tool_id}:{token_storage_key}) → token found?
│   │   │
│   │   ├─ YES → is access_token expired?
│   │   │   │
│   │   │   ├─ NO → inject token, send request
│   │   │   │
│   │   │   └─ YES → has refresh_token?
│   │   │       │
│   │   │       ├─ YES → http POST to token_url with refresh_token
│   │   │       │        → memory.store(oauth:{tool_id}:{token_storage_key}, new tokens)
│   │   │       │        → inject new token, send request
│   │   │       │
│   │   │       └─ NO → initiate re-authorization (see below)
│   │   │
│   │   └─ NO → initiate authorization
│   │       │
│   │       ├─ Build authorization URL (with scopes, redirect, PKCE)
│   │       ├─ interact(mode: "ask",
│   │       │    message: "I need access to Gmail. Click to authorize: <url>
│   │       │             Then paste the code you receive.")
│   │       ├─ Receive auth code from user
│   │       ├─ http POST to token_url (exchange code for tokens)
│   │       ├─ memory.store(oauth:{tool_id}:{token_storage_key}, tokens)
│   │       └─ inject token, send original request
```

This entire flow is derived from the auth section of the spec. Zero custom code per tool.

---

### Connection Section

```json
{
  "connection": {
    "base_url": "https://api.github.com",
    "default_headers": {
      "Accept": "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    "rate_limit": {
      "requests": 5000,
      "period": "hour",
      "strategy": "respect_headers",
      "retry_after_header": "X-RateLimit-Reset"
    }
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `base_url` | string | yes | Prepended to all operation paths |
| `default_headers` | object | no | Included in every request. Auth headers are added automatically by middleware — do NOT put auth here. |
| `rate_limit` | object | no | Rate limiting configuration |
| `rate_limit.requests` | number | no | Max requests per period |
| `rate_limit.period` | `"second"`, `"minute"`, `"hour"` | no | Time window |
| `rate_limit.strategy` | `"fixed_window"` or `"respect_headers"` | no | How to enforce. `"respect_headers"` reads the API's rate limit response headers. |
| `rate_limit.retry_after_header` | string | no | Header name that tells us when we can retry |

---

### Memory Keys Section

Tools can declare named memory slots for storing persistent state across sessions. These are **keyed memories** - exact-lookup values that the tool needs to reliably retrieve (as opposed to fuzzy memories the model stores opportunistically).

The runtime automatically prefixes each key with the tool ID, guaranteeing global uniqueness without coordination between tool authors.

```json
{
  "memory_keys": {
    "preferred_store": {
      "description": "The user's preferred grocery store or delivery service"
    },
    "delivery_day": {
      "description": "Preferred day of the week for grocery delivery"
    },
    "family_size": {
      "description": "Number of people to plan meals for"
    }
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `{key_name}` | object | - | Each key is a short, descriptive identifier. No prefixes needed - the runtime adds `{tool_id}:` automatically. |
| `{key_name}.description` | string | yes | What this memory slot stores. Written for both the model and human reviewers. |

**How it works at runtime:**

1. Tool spec declares `"tool": "grocery"` and `"memory_keys": { "preferred_store": { ... } }`
2. Agent calls `memory.store(key: "preferred_store", content: "Whole Foods on Main St")`
3. Runtime stores with derived key `grocery:preferred_store`
4. Agent calls `memory.get(key: "preferred_store")`
5. Runtime looks up `grocery:preferred_store`, returns the content

The tool never sees the prefix. Collision is impossible.

**Auth keys follow the same pattern** with an extra namespace:
- Tool declares `"token_storage_key": "tokens"` in its auth section
- Runtime stores as `oauth:{tool_id}:tokens`
- Pattern: `oauth:{tool_id}:{token_storage_key}`

**Uniqueness enforcement:** At spec load time, the runtime reads `memory_keys` from all loaded tool specs, computes derived keys, and checks for collisions. Duplicates are a load-time error - caught immediately, not at runtime.

### Resources Section

Operations are grouped under resources. A resource represents a logical entity in the API (issues, pull requests, users, messages, etc.).

```json
{
  "resources": {
    "issues": {
      "description": "GitHub Issues — bug reports, feature requests, tasks",
      "operations": {
        "get": { },
        "list": { },
        "create": { },
        "update": { },
        "list_comments": { },
        "create_comment": { }
      }
    },
    "pulls": {
      "description": "Pull Requests — code changes proposed for merging",
      "operations": {
        "create": { },
        "list_files": { }
      }
    }
  }
}
```

**Operation IDs** are formed as `{resource}.{operation}`. For example: `issues.get`, `pulls.create`, `issues.create_comment`. This gives the model a scannable hierarchy while maintaining unique, referenceable IDs.

---

### Operation Schema

Each operation describes a single API action.

```json
{
  "get": {
    "description": "Retrieve a single issue by number. Returns the issue title, body, labels, assignees, state, and metadata.",
    "when_to_use": "Use this to read the details of a specific issue before working on it.",
    "primitive": "http",
    "method": "GET",
    "path": "/repos/{owner}/{repo}/issues/{issue_number}",

    "params": {
      "owner": {
        "in": "path",
        "type": "string",
        "required": true,
        "description": "Repository owner (user or organization)"
      },
      "repo": {
        "in": "path",
        "type": "string",
        "required": true,
        "description": "Repository name"
      },
      "issue_number": {
        "in": "path",
        "type": "integer",
        "required": true,
        "description": "The issue number (not the issue ID)"
      }
    },

    "response": {
      "description": "The issue object",
      "important_fields": {
        "title": "string — the issue title",
        "body": "string — the full issue description (markdown)",
        "state": "string — 'open' or 'closed'",
        "labels": "array — label objects with 'name' field",
        "assignees": "array — user objects with 'login' field",
        "created_at": "string — ISO 8601 timestamp",
        "html_url": "string — browser URL to view the issue"
      }
    },

    "errors": {
      "404": {
        "meaning": "Issue not found. Either the issue number is wrong or the repo doesn't exist.",
        "recovery": "Verify the owner, repo, and issue number. Check if the repo is private and auth is configured."
      },
      "401": {
        "meaning": "Authentication failed or token lacks required scopes.",
        "recovery": "Auth middleware will handle token refresh automatically. If this persists, the token may lack 'repo' scope — notify the user."
      }
    }
  }
}
```

#### Operation Fields

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `description` | string | yes | What this operation does. Factual, concise. |
| `when_to_use` | string | yes | **For the model.** Natural language guidance on when to choose this operation. This is what makes the spec model-readable, not just machine-parseable. |
| `primitive` | string | yes | Which primitive executes this. Almost always `"http"` for API tools. |
| `method` | string | for http | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | string | for http | URL path appended to `connection.base_url`. Use `{param_name}` for path parameters. |
| `params` | object | no | Parameters for the request. See Params Schema. |
| `body` | object | no | Request body definition. See Body Schema. |
| `side_effects` | object | no | Describes what changes in the world when this operation executes. Model hint for decision-making — helps the agent decide when to ask for approval. Omit for read-only operations (GET). See Side Effects Schema. |
| `response` | object | yes | Description of what comes back. See Response Schema. |
| `errors` | object | no | Known error codes and recovery instructions. See Errors Schema. |
| `pagination` | object | no | How to page through results. See Pagination Schema. |

---

### Params Schema

```json
{
  "owner": {
    "in": "path",
    "type": "string",
    "required": true,
    "description": "Repository owner"
  },
  "state": {
    "in": "query",
    "type": "string",
    "required": false,
    "default": "open",
    "enum": ["open", "closed", "all"],
    "description": "Filter by issue state"
  },
  "per_page": {
    "in": "query",
    "type": "integer",
    "required": false,
    "default": 30,
    "description": "Number of results per page (max 100)"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `in` | `"path"`, `"query"`, `"header"` | yes | Where the param goes in the HTTP request |
| `type` | `"string"`, `"integer"`, `"number"`, `"boolean"`, `"array"` | yes | Data type |
| `required` | boolean | yes | Whether the param must be provided |
| `default` | any | no | Default value if not provided |
| `enum` | array | no | Allowed values |
| `description` | string | yes | What this param does — for the model |

---

### Body Schema

For operations that send a request body (POST, PUT, PATCH):

```json
{
  "body": {
    "content_type": "application/json",
    "fields": {
      "title": {
        "type": "string",
        "required": true,
        "description": "PR title. Should be concise and descriptive."
      },
      "body": {
        "type": "string",
        "required": false,
        "description": "PR description. Supports markdown. Include a summary of changes and link to the issue."
      },
      "head": {
        "type": "string",
        "required": true,
        "description": "The name of the branch where your changes are. For cross-repo PRs, prefix with 'username:'."
      },
      "base": {
        "type": "string",
        "required": true,
        "description": "The name of the branch you want to merge into. Usually 'main' or 'master'."
      },
      "draft": {
        "type": "boolean",
        "required": false,
        "default": false,
        "description": "Set to true to create a draft PR that cannot be merged until marked ready."
      }
    }
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `content_type` | string | yes | MIME type. Usually `"application/json"`. Also supports `"multipart/form-data"`, `"application/x-www-form-urlencoded"`. |
| `fields` | object | yes | Body fields. Same schema as params (type, required, default, enum, description) but without `in`. |

---

### Response Schema

The response section does NOT exhaustively type every field. It highlights the **important fields** the model is likely to need for subsequent operations.

```json
{
  "response": {
    "description": "The newly created pull request",
    "important_fields": {
      "number": "integer — the PR number, used to reference this PR in other operations",
      "html_url": "string — browser URL to view the PR, useful for sharing with users",
      "state": "string — 'open', 'closed', or 'merged'",
      "head.ref": "string — the branch name with changes",
      "base.ref": "string — the target branch",
      "mergeable": "boolean — whether the PR can be cleanly merged (may be null while computing)"
    }
  }
}
```

**Design decision:** `important_fields` uses a simple `"field_name": "type — description"` format rather than a nested schema. This is deliberately informal. The model doesn't need a JSON Schema for the response — it needs to know which fields matter and what they mean. If the model needs a field not listed here, it can inspect the actual response or consult `docs_url`.

---

### Errors Schema

```json
{
  "errors": {
    "404": {
      "meaning": "The resource was not found.",
      "recovery": "Check that all path parameters are correct. Verify the resource exists."
    },
    "401": {
      "meaning": "Authentication failed.",
      "recovery": "Auth middleware handles token refresh. If this persists after refresh, notify the user — the token may need re-authorization."
    },
    "403": {
      "meaning": "Permission denied. The token lacks required scopes, or the resource is restricted.",
      "recovery": "Check required scopes. For rate limiting, see the rate_limit section."
    },
    "422": {
      "meaning": "Validation error. The request body has invalid or missing fields.",
      "recovery": "Read the response body for specific field errors. Fix the request and retry."
    },
    "409": {
      "meaning": "Conflict. For PRs, the head branch may not have any new commits relative to base.",
      "recovery": "Ensure the branch has commits that differ from the base branch."
    }
  }
}
```

**Key design choice:** `recovery` is natural language, written for the model. It tells the agent *what to do*, not just what went wrong. This is what makes the spec actionable — the model can read the error, match it to the spec, and follow the recovery instruction without human guidance.

---

### Pagination Schema

Many APIs return paginated results. The spec describes how pagination works so the model knows how to get all results.

#### Cursor-based pagination (GitHub, Slack)

```json
{
  "pagination": {
    "type": "cursor",
    "description": "GitHub uses Link header-based pagination",
    "mechanism": "link_header",
    "has_more": "Check for 'rel=\"next\"' in the Link response header",
    "next_page": "Follow the URL in the Link header with rel=\"next\"",
    "max_per_page": 100,
    "per_page_param": "per_page"
  }
}
```

#### Offset-based pagination

```json
{
  "pagination": {
    "type": "offset",
    "description": "Standard offset pagination",
    "offset_param": "offset",
    "limit_param": "limit",
    "max_per_page": 50,
    "total_field": "total_count",
    "has_more": "offset + limit < total_count"
  }
}
```

#### Page-number pagination

```json
{
  "pagination": {
    "type": "page_number",
    "description": "Page number based pagination",
    "page_param": "page",
    "per_page_param": "per_page",
    "max_per_page": 100,
    "total_pages_field": "total_pages",
    "has_more": "page < total_pages"
  }
}
```

---

### Side Effects Schema

Mutating operations (POST, PUT, PATCH, DELETE) should include a `side_effects` field that describes what changes in the world when the operation executes. This field is a **model hint** — it helps the agent understand consequences and decide when to seek approval. It is NOT a safety enforcement mechanism (that's the Policy Layer's job — see the architecture doc).

Omit `side_effects` for read-only operations (GET). Its absence means "this operation has no side effects."

```json
{
  "side_effects": {
    "description": "Posts a visible comment on the GitHub issue. All repository watchers and issue subscribers will receive an email notification.",
    "reversible": true
  }
}
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `description` | string | yes | Natural language explanation of what changes when this operation runs. Written for the model. Should cover: what gets created/modified/deleted, who can see the change, and any notifications triggered. |
| `reversible` | boolean | yes | Can this action be undone? `true` if there's a corresponding delete/undo operation. `false` if the action is permanent (e.g., sending an email, triggering a payment). |

**Design intent:** This is deliberately minimal — just two fields. The `description` carries the nuance (who's affected, what notifications fire, how visible the change is). The `reversible` flag gives a quick machine-readable signal that both the model and runtime/UI can use. The model is smart enough to infer severity and appropriate caution from a good description.

**What `side_effects` does NOT do:** It does not enforce any safety policy. An agent can read `reversible: false` and still proceed without asking. Safety enforcement lives in the Policy Layer (a separate runtime configuration the agent cannot access). See the architecture doc for details.

---

## Complete Example: GitHub Tool Spec

```json
{
  "spec_version": "0.1",
  "tool": "github",
  "name": "GitHub",
  "description": "Interact with GitHub repositories, issues, pull requests, and code. Use this tool for all source code management operations: reading issues, creating branches, opening PRs, and managing code reviews.",
  "docs_url": "https://docs.github.com/en/rest",

  "auth": {
    "type": "bearer_token",
    "description": "GitHub Personal Access Token or GitHub App token. Requires 'repo' scope for private repositories.",
    "env_var": "GITHUB_TOKEN"
  },

  "connection": {
    "base_url": "https://api.github.com",
    "default_headers": {
      "Accept": "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    "rate_limit": {
      "requests": 5000,
      "period": "hour",
      "strategy": "respect_headers",
      "retry_after_header": "X-RateLimit-Reset"
    }
  },

  "memory_keys": {
    "default_repo": {
      "description": "The owner/repo the user most commonly works with. Avoids asking every time."
    },
    "conventions": {
      "description": "Learned coding conventions for the primary repo (commit style, branch naming, PR template)."
    }
  },

  "resources": {

    "issues": {
      "description": "GitHub Issues — bug reports, feature requests, and tasks. Issues can have labels, assignees, milestones, and comments.",

      "operations": {

        "get": {
          "description": "Retrieve a single issue by number.",
          "when_to_use": "Use when you need to read the full details of a specific issue — its description, labels, assignees, and current state.",
          "primitive": "http",
          "method": "GET",
          "path": "/repos/{owner}/{repo}/issues/{issue_number}",
          "params": {
            "owner": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository owner (user or organization)"
            },
            "repo": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository name"
            },
            "issue_number": {
              "in": "path",
              "type": "integer",
              "required": true,
              "description": "The issue number"
            }
          },
          "response": {
            "description": "The issue object with full details",
            "important_fields": {
              "number": "integer — the issue number",
              "title": "string — issue title",
              "body": "string — full description in markdown",
              "state": "string — 'open' or 'closed'",
              "labels": "array — objects with 'name' field (e.g., 'bug', 'enhancement')",
              "assignees": "array — user objects with 'login' field",
              "milestone": "object or null — with 'title' field if set",
              "html_url": "string — browser URL to the issue",
              "created_at": "string — ISO 8601 timestamp",
              "updated_at": "string — ISO 8601 timestamp"
            }
          },
          "errors": {
            "404": {
              "meaning": "Issue not found.",
              "recovery": "Verify owner, repo, and issue_number. Check if repo is private and token has 'repo' scope."
            },
            "401": {
              "meaning": "Bad or missing token.",
              "recovery": "Ensure GITHUB_TOKEN is set and valid."
            }
          }
        },

        "list": {
          "description": "List issues in a repository, with optional filters.",
          "when_to_use": "Use when you need to find issues matching criteria — e.g., all open bugs, issues assigned to a user, or recent issues.",
          "primitive": "http",
          "method": "GET",
          "path": "/repos/{owner}/{repo}/issues",
          "params": {
            "owner": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository owner"
            },
            "repo": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository name"
            },
            "state": {
              "in": "query",
              "type": "string",
              "required": false,
              "default": "open",
              "enum": ["open", "closed", "all"],
              "description": "Filter by state"
            },
            "labels": {
              "in": "query",
              "type": "string",
              "required": false,
              "description": "Comma-separated label names to filter by (e.g., 'bug,high-priority')"
            },
            "assignee": {
              "in": "query",
              "type": "string",
              "required": false,
              "description": "GitHub username to filter by assignee. Use '*' for any assignee, 'none' for unassigned."
            },
            "sort": {
              "in": "query",
              "type": "string",
              "required": false,
              "default": "created",
              "enum": ["created", "updated", "comments"],
              "description": "Sort field"
            },
            "direction": {
              "in": "query",
              "type": "string",
              "required": false,
              "default": "desc",
              "enum": ["asc", "desc"],
              "description": "Sort direction"
            },
            "per_page": {
              "in": "query",
              "type": "integer",
              "required": false,
              "default": 30,
              "description": "Results per page (max 100)"
            }
          },
          "response": {
            "description": "Array of issue objects",
            "important_fields": {
              "[].number": "integer — issue number",
              "[].title": "string — issue title",
              "[].state": "string — 'open' or 'closed'",
              "[].labels": "array — label objects with 'name'",
              "[].assignees": "array — user objects with 'login'",
              "[].created_at": "string — ISO 8601 timestamp",
              "[].pull_request": "object or null — if present, this 'issue' is actually a PR"
            }
          },
          "pagination": {
            "type": "cursor",
            "mechanism": "link_header",
            "has_more": "Check for rel=\"next\" in Link response header",
            "next_page": "Follow the URL in the Link header with rel=\"next\"",
            "max_per_page": 100,
            "per_page_param": "per_page"
          }
        },

        "create_comment": {
          "description": "Add a comment to an issue.",
          "when_to_use": "Use to ask clarifying questions on an issue, provide status updates, or communicate with other contributors.",
          "side_effects": {
            "description": "Posts a visible comment on the issue. All repository watchers and issue subscribers receive an email notification. The comment is attributed to the authenticated user.",
            "reversible": true
          },
          "primitive": "http",
          "method": "POST",
          "path": "/repos/{owner}/{repo}/issues/{issue_number}/comments",
          "params": {
            "owner": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository owner"
            },
            "repo": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository name"
            },
            "issue_number": {
              "in": "path",
              "type": "integer",
              "required": true,
              "description": "The issue number to comment on"
            }
          },
          "body": {
            "content_type": "application/json",
            "fields": {
              "body": {
                "type": "string",
                "required": true,
                "description": "The comment text. Supports GitHub-flavored markdown."
              }
            }
          },
          "response": {
            "description": "The created comment object",
            "important_fields": {
              "id": "integer — unique comment ID",
              "html_url": "string — browser URL to the comment",
              "created_at": "string — ISO 8601 timestamp"
            }
          },
          "errors": {
            "404": {
              "meaning": "Issue not found.",
              "recovery": "Verify the issue number exists and is accessible."
            },
            "422": {
              "meaning": "Validation error — likely empty comment body.",
              "recovery": "Ensure the 'body' field is a non-empty string."
            }
          }
        },

        "list_comments": {
          "description": "List all comments on an issue.",
          "when_to_use": "Use when you need the full discussion context of an issue — all comments, clarifications, and decisions made in the thread.",
          "primitive": "http",
          "method": "GET",
          "path": "/repos/{owner}/{repo}/issues/{issue_number}/comments",
          "params": {
            "owner": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository owner"
            },
            "repo": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository name"
            },
            "issue_number": {
              "in": "path",
              "type": "integer",
              "required": true,
              "description": "The issue number"
            },
            "per_page": {
              "in": "query",
              "type": "integer",
              "required": false,
              "default": 30,
              "description": "Results per page (max 100)"
            }
          },
          "response": {
            "description": "Array of comment objects",
            "important_fields": {
              "[].id": "integer — comment ID",
              "[].body": "string — comment text in markdown",
              "[].user.login": "string — who wrote the comment",
              "[].created_at": "string — ISO 8601 timestamp"
            }
          },
          "pagination": {
            "type": "cursor",
            "mechanism": "link_header",
            "has_more": "Check for rel=\"next\" in Link response header",
            "next_page": "Follow the URL in Link header with rel=\"next\"",
            "max_per_page": 100,
            "per_page_param": "per_page"
          }
        }
      }
    },

    "pulls": {
      "description": "Pull Requests — proposed code changes. PRs are also issues in GitHub's data model, so they appear in issue listings.",

      "operations": {

        "create": {
          "description": "Open a new pull request.",
          "when_to_use": "Use after pushing a branch with changes to propose merging those changes into a base branch. Always include a descriptive title and body linking to the relevant issue.",
          "side_effects": {
            "description": "Opens a pull request visible to all repository collaborators. Triggers notifications to repository watchers. If the repo has CI/CD configured, it will start running checks on the PR branch.",
            "reversible": true
          },
          "primitive": "http",
          "method": "POST",
          "path": "/repos/{owner}/{repo}/pulls",
          "params": {
            "owner": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository owner"
            },
            "repo": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository name"
            }
          },
          "body": {
            "content_type": "application/json",
            "fields": {
              "title": {
                "type": "string",
                "required": true,
                "description": "PR title. Should be concise and follow the project's commit/PR conventions."
              },
              "body": {
                "type": "string",
                "required": false,
                "description": "PR description in markdown. Best practice: link the issue (e.g., 'Closes #127'), summarize changes, note test coverage."
              },
              "head": {
                "type": "string",
                "required": true,
                "description": "Branch name containing your changes."
              },
              "base": {
                "type": "string",
                "required": true,
                "description": "Branch to merge into. Usually 'main'."
              },
              "draft": {
                "type": "boolean",
                "required": false,
                "default": false,
                "description": "Create as a draft PR. Use when changes are not yet ready for review."
              }
            }
          },
          "response": {
            "description": "The created pull request",
            "important_fields": {
              "number": "integer — PR number, used to reference this PR",
              "html_url": "string — browser URL to view the PR",
              "state": "string — 'open'",
              "head.ref": "string — source branch name",
              "base.ref": "string — target branch name"
            }
          },
          "errors": {
            "422": {
              "meaning": "Validation error. Common causes: head branch doesn't exist, no commits between head and base, or a PR already exists for this head/base combo.",
              "recovery": "Check that the branch was pushed successfully. Verify there are commits on the branch that differ from base. If a PR already exists, find it with pulls.list instead."
            },
            "404": {
              "meaning": "Repository not found or insufficient permissions.",
              "recovery": "Verify owner/repo and that the token has 'repo' scope."
            }
          }
        },

        "list_files": {
          "description": "List files changed in a pull request.",
          "when_to_use": "Use to review what files were modified in a PR — useful for verifying your changes match expectations before requesting review.",
          "primitive": "http",
          "method": "GET",
          "path": "/repos/{owner}/{repo}/pulls/{pull_number}/files",
          "params": {
            "owner": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository owner"
            },
            "repo": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository name"
            },
            "pull_number": {
              "in": "path",
              "type": "integer",
              "required": true,
              "description": "The PR number"
            }
          },
          "response": {
            "description": "Array of changed file objects",
            "important_fields": {
              "[].filename": "string — path of the changed file",
              "[].status": "string — 'added', 'removed', 'modified', 'renamed'",
              "[].additions": "integer — lines added",
              "[].deletions": "integer — lines removed",
              "[].patch": "string — unified diff patch (may be absent for binary files)"
            }
          },
          "pagination": {
            "type": "cursor",
            "mechanism": "link_header",
            "has_more": "Check for rel=\"next\" in Link response header",
            "next_page": "Follow the URL in Link header with rel=\"next\"",
            "max_per_page": 100,
            "per_page_param": "per_page"
          }
        }
      }
    },

    "repos": {
      "description": "Repository metadata and content.",

      "operations": {

        "get": {
          "description": "Get repository metadata.",
          "when_to_use": "Use to learn about a repository — its default branch, language, visibility, and description. Useful as a first step when starting work on an unfamiliar repo.",
          "primitive": "http",
          "method": "GET",
          "path": "/repos/{owner}/{repo}",
          "params": {
            "owner": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository owner"
            },
            "repo": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "Repository name"
            }
          },
          "response": {
            "description": "Repository object with metadata",
            "important_fields": {
              "full_name": "string — 'owner/repo' format",
              "default_branch": "string — usually 'main' or 'master'",
              "language": "string — primary programming language",
              "private": "boolean — whether the repo is private",
              "description": "string — repo description",
              "html_url": "string — browser URL"
            }
          }
        }
      }
    }
  }
}
```

---

## Complete Example: Gmail Tool Spec (OAuth2)

This example demonstrates the OAuth2 auth flow.

```json
{
  "spec_version": "0.1",
  "tool": "gmail",
  "name": "Gmail",
  "description": "Read and send emails via Gmail. Use this tool for all email operations: reading inbox, searching messages, drafting and sending replies.",
  "docs_url": "https://developers.google.com/gmail/api/reference/rest",

  "auth": {
    "type": "oauth2",
    "description": "Google OAuth 2.0. Requires user authorization to access their Gmail account.",
    "flow": "authorization_code",
    "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_url": "https://oauth2.googleapis.com/token",
    "scopes": [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send"
    ],
    "credentials": {
      "client_id_env": "GOOGLE_CLIENT_ID",
      "client_secret_env": "GOOGLE_CLIENT_SECRET"
    },
    "pkce": true,
    "token_storage_key": "tokens"
  },

  "connection": {
    "base_url": "https://gmail.googleapis.com/gmail/v1",
    "default_headers": {
      "Accept": "application/json"
    },
    "rate_limit": {
      "requests": 250,
      "period": "minute",
      "strategy": "fixed_window"
    }
  },

  "memory_keys": {
    "user_email": {
      "description": "The authenticated user's email address, learned after first API call."
    },
    "signature": {
      "description": "The user's preferred email signature for outgoing messages."
    }
  },

  "resources": {

    "messages": {
      "description": "Email messages in the user's mailbox.",

      "operations": {

        "list": {
          "description": "List messages in the user's mailbox matching a query.",
          "when_to_use": "Use to find emails — search by sender, subject, date, labels. Returns message IDs; follow up with messages.get for full content.",
          "primitive": "http",
          "method": "GET",
          "path": "/users/me/messages",
          "params": {
            "q": {
              "in": "query",
              "type": "string",
              "required": false,
              "description": "Gmail search query. Same syntax as the Gmail search box. Examples: 'from:boss@company.com', 'subject:meeting after:2026/03/01', 'is:unread label:inbox'"
            },
            "maxResults": {
              "in": "query",
              "type": "integer",
              "required": false,
              "default": 10,
              "description": "Max messages to return (max 500)"
            },
            "labelIds": {
              "in": "query",
              "type": "array",
              "required": false,
              "description": "Filter by label IDs. Common: 'INBOX', 'SENT', 'UNREAD'"
            }
          },
          "response": {
            "description": "Object with message ID list and optional next page token",
            "important_fields": {
              "messages": "array — objects with 'id' and 'threadId' fields",
              "nextPageToken": "string — token for next page of results",
              "resultSizeEstimate": "integer — estimated total results"
            }
          },
          "pagination": {
            "type": "cursor",
            "mechanism": "response_field",
            "cursor_field": "nextPageToken",
            "cursor_param": "pageToken",
            "has_more": "nextPageToken field is present and non-null"
          }
        },

        "get": {
          "description": "Get a specific message by ID, including full content.",
          "when_to_use": "Use after messages.list to read the full email content. Returns headers (from, to, subject, date) and body.",
          "primitive": "http",
          "method": "GET",
          "path": "/users/me/messages/{message_id}",
          "params": {
            "message_id": {
              "in": "path",
              "type": "string",
              "required": true,
              "description": "The message ID from messages.list"
            },
            "format": {
              "in": "query",
              "type": "string",
              "required": false,
              "default": "full",
              "enum": ["minimal", "full", "raw", "metadata"],
              "description": "'full' includes parsed headers and body. 'metadata' for headers only. 'raw' for the raw RFC 2822 message."
            }
          },
          "response": {
            "description": "The full message object",
            "important_fields": {
              "id": "string — message ID",
              "threadId": "string — conversation thread ID",
              "snippet": "string — short preview of the message body",
              "payload.headers": "array — look for 'From', 'To', 'Subject', 'Date' headers by name",
              "payload.body.data": "string — base64url-encoded body (for simple messages)",
              "payload.parts": "array — MIME parts (for multipart messages, body is in parts)"
            }
          },
          "errors": {
            "404": {
              "meaning": "Message not found. It may have been deleted or the ID is wrong.",
              "recovery": "Verify the message ID. Re-run messages.list to get fresh IDs."
            }
          }
        },

        "send": {
          "description": "Send an email message.",
          "when_to_use": "Use to send a new email or reply. The message must be provided as a base64url-encoded RFC 2822 formatted string. For replies, include the In-Reply-To and References headers, and use the same threadId.",
          "side_effects": {
            "description": "Sends an email from the user's Gmail account. Recipients receive the message immediately. The email cannot be recalled or unsent after delivery. The message appears in the user's Sent folder.",
            "reversible": false
          },
          "primitive": "http",
          "method": "POST",
          "path": "/users/me/messages/send",
          "body": {
            "content_type": "application/json",
            "fields": {
              "raw": {
                "type": "string",
                "required": true,
                "description": "Base64url-encoded RFC 2822 email message. Must include To, From, Subject headers and the message body. For replies, include In-Reply-To and References headers."
              },
              "threadId": {
                "type": "string",
                "required": false,
                "description": "Thread ID to send the reply in. Include this for replies to keep the conversation threaded."
              }
            }
          },
          "response": {
            "description": "The sent message metadata",
            "important_fields": {
              "id": "string — ID of the sent message",
              "threadId": "string — thread the message belongs to",
              "labelIds": "array — will include 'SENT'"
            }
          },
          "errors": {
            "400": {
              "meaning": "Invalid message format. The raw field is not valid base64url or the RFC 2822 format is wrong.",
              "recovery": "Verify the message is properly formatted: headers separated from body by blank line, all base64url encoded. Common mistake: using standard base64 instead of base64url (replace + with -, / with _, remove = padding)."
            }
          }
        }
      }
    }
  }
}
```

---

## Spec Design Decisions Log

### Decision 1: `when_to_use` as a first-class field

**Why:** The model needs to choose the right operation from potentially dozens in a tool spec. `description` says what it does. `when_to_use` says when to pick it. This is the difference between a reference manual and a guide.

**Alternative considered:** Relying on `description` alone. Rejected because descriptions tend to be factual ("List issues in a repository") rather than contextual ("Use when you need to find issues matching criteria").

### Decision 2: `important_fields` instead of full response schemas

**Why:** Full JSON Schema for responses would double the spec size and mostly go unread by the model. The model needs to know "the PR number is in the `number` field" — not the complete OpenAPI response definition.

**Tradeoff:** If the model needs an unlisted field, it has to inspect the actual response or check `docs_url`. This is acceptable — the spec covers the 90% case.

### Decision 3: `recovery` in error specs is natural language

**Why:** The model is the error handler. It reads the error, looks up the spec, and decides what to do. Natural language recovery instructions are the most effective format for model-driven decision making.

**Alternative considered:** Structured recovery actions (e.g., `"retry": true, "max_retries": 3`). Rejected because recovery is often contextual — the right action depends on what the agent was trying to accomplish, not just which error occurred.

### Decision 4: Resources as groups, operations as flat within groups

**Why:** A tool like GitHub might have 50+ operations. Flat lists are hard to scan. Grouping by resource (issues, pulls, repos) lets the model navigate hierarchically: "I need to do something with pull requests → look at `resources.pulls.operations`."

**Operation IDs** are implicitly `{resource}.{operation}`: `issues.get`, `pulls.create`. No need for a separate ID field.

### Decision 5: Auth is a top-level concern, not per-operation

**Why:** 99% of APIs use the same auth for all operations. Putting auth at the top level and having the runtime inject it automatically means operations never think about auth. If a tool ever needs per-operation auth (rare), it can override with operation-level auth in a future spec version.

### Decision 6: Pagination is per-operation, not per-tool

**Why:** Different endpoints on the same API can use different pagination styles. GitHub uses Link headers for most things, but some endpoints use different patterns. Per-operation pagination keeps things accurate.

### Decision 7: `side_effects` is a model hint, not safety enforcement

**Why:** Mutating operations have consequences — posting comments notifies watchers, sending emails can't be unsent, creating orders costs money. The model needs to understand these consequences to make good decisions about when to proceed autonomously vs. when to ask for approval.

**Why not enforcement:** Two reasons. First, agents can generate their own tool specs, so self-reported safety fields can be manipulated. Second, even with accurate side effects, the model might choose to proceed anyway. Safety enforcement must live in a layer the agent cannot influence - the Policy Layer (see architecture doc).

**Design:** Two fields only - `description` (natural language for the model) and `reversible` (boolean flag for the model and runtime). We deliberately avoided adding severity enums, impact scores, or approval-required flags to this field. The model can infer appropriate caution from a well-written description. Hard enforcement belongs in the Policy Layer.

**Alternative considered:** A `requires_approval` boolean on each operation. Rejected because approval requirements depend on context (who's the user, what's the policy, how trusted is the spec), not on the operation alone. A grocery order might need approval for one user and not another.

### Decision 8: `memory_keys` are auto-prefixed with the tool ID

**Why:** Tools need reliable, deterministic storage for state like user preferences and configuration. But if two tools both declare a key called `"last_used"`, they'd collide in the shared memory store.

**Design:** The runtime automatically prefixes every declared key with the tool ID: a tool with `"tool": "grocery"` declaring `"preferred_store"` gets the derived key `grocery:preferred_store`. The tool never sees the prefix - it just calls `get("preferred_store")` and the runtime scopes it.

**Auth keys** add an extra namespace segment: `oauth:{tool_id}:{token_storage_key}`. This keeps auth middleware concerns cleanly separated from tool state while maintaining the same uniqueness guarantee.

**Why not let tools manage their own prefixes?** Because they'd forget, or use inconsistent formats, or collide anyway. Automatic derivation makes uniqueness a structural guarantee, not a convention that can be violated.

---

## Open Questions for v0.2

1. **Webhooks / event subscriptions.** Should the spec describe how to register for events? This connects to the `schedule` primitive (event-based triggers). e.g., "To receive issue assignment events, POST to /repos/{owner}/{repo}/hooks with config..."

2. **Composite operations.** Some useful actions require multiple API calls (e.g., "fork a repo, create a branch, make changes, open a PR"). Should the spec support describing multi-step workflows? Or is that purely the model's job?

3. **File uploads / binary data.** The current body schema handles JSON well. Multipart form data for file uploads needs more thought.

4. **GraphQL tools.** The current spec assumes REST. GraphQL APIs (GitHub v4, Shopify, Hasura) have a single endpoint with query-based operations. May need a `"api_style": "graphql"` variant.

5. **Spec discovery.** How does the agent find specs? A local directory? A registry URL? Auto-discovery from a base URL (like checking for `/agent.json`)?

6. **Versioning.** When an API changes, how does the spec update? Who maintains it? Could specs be auto-generated from OpenAPI definitions?

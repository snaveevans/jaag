import type { ToolSpec } from "../specs/types.ts";

export function buildMockBearerToolSpec(baseUrl: string): ToolSpec {
  return {
    spec_version: "0.1",
    tool: "mockapi",
    name: "Mock API",
    description: "Mock API for interpreter and dispatcher tests.",
    auth: {
      type: "bearer_token",
      description: "Bearer token auth for tests.",
      env_var: "MOCK_API_TOKEN",
    },
    connection: {
      base_url: baseUrl,
      default_headers: {
        Accept: "application/json",
      },
      rate_limit: {
        strategy: "respect_headers",
        retry_after_header: "Retry-After",
      },
    },
    resources: {
      items: {
        description: "Test items.",
        operations: {
          list: {
            description: "List items.",
            when_to_use: "Use when you need a filtered list of mock items.",
            primitive: "http",
            method: "GET",
            path: "/items/{owner}",
            params: {
              owner: {
                in: "path",
                type: "string",
                required: true,
                description: "Owner segment.",
              },
              state: {
                in: "query",
                type: "string",
                required: false,
                default: "open",
                enum: ["open", "closed"],
                description: "Item state filter.",
              },
              per_page: {
                in: "query",
                type: "integer",
                required: false,
                default: 25,
                description: "Items per page.",
              },
            },
            response: {
              description: "Array of item summaries.",
              important_fields: {
                "[].id": "integer - item id.",
                "[].name": "string - item name.",
              },
            },
            pagination: {
              type: "cursor",
              mechanism: "link_header",
              has_more: "Look for rel=next in the Link header.",
              next_page: "Follow the rel=next URL.",
            },
          },
        },
      },
    },
  };
}

export function buildMockOAuthToolSpec(baseUrl: string): ToolSpec {
  return {
    spec_version: "0.1",
    tool: "oauthmock",
    name: "OAuth Mock",
    description: "Mock OAuth API for auth refresh tests.",
    auth: {
      type: "oauth2",
      description: "OAuth authorization code flow for tests.",
      flow: "authorization_code",
      authorization_url: `${baseUrl}/oauth/authorize`,
      token_url: `${baseUrl}/oauth/token`,
      scopes: ["read:data"],
      credentials: {
        client_id_env: "MOCK_CLIENT_ID",
        client_secret_env: "MOCK_CLIENT_SECRET",
      },
      token_storage_key: "tokens",
    },
    connection: {
      base_url: baseUrl,
      default_headers: {
        Accept: "application/json",
      },
    },
    resources: {
      profile: {
        description: "Mock profile resource.",
        operations: {
          get: {
            description: "Get profile details.",
            when_to_use: "Use when you need the current mock profile.",
            primitive: "http",
            method: "GET",
            path: "/profile",
            response: {
              description: "Profile payload.",
              important_fields: {
                id: "string - profile id.",
                name: "string - profile name.",
              },
            },
            errors: {
              "401": {
                meaning: "Auth failed.",
                recovery: "Refresh the token and retry.",
              },
            },
          },
        },
      },
    },
  };
}

export function buildMockMutationToolSpec(baseUrl: string): ToolSpec {
  return {
    spec_version: "0.1",
    tool: "mockmail",
    name: "Mock Mail",
    description: "Mock mutation API for approval-flow tests.",
    auth: {
      type: "none",
      description: "No auth required for tests.",
    },
    connection: {
      base_url: baseUrl,
      default_headers: {
        Accept: "application/json",
      },
    },
    resources: {
      messages: {
        description: "Mock message resource.",
        operations: {
          send: {
            description: "Send a mock message.",
            when_to_use: "Use when you need to test a mutating HTTP operation.",
            primitive: "http",
            method: "POST",
            path: "/messages",
            body: {
              content_type: "application/json",
              fields: {
                subject: {
                  type: "string",
                  required: true,
                  description: "Message subject.",
                },
                body: {
                  type: "string",
                  required: true,
                  description: "Message body.",
                },
              },
            },
            response: {
              description: "Sent message payload.",
              important_fields: {
                id: "string - sent message id.",
              },
            },
          },
        },
      },
    },
  };
}

export function buildInvalidToolSpec(): Record<string, unknown> {
  return {
    spec_version: "0.1",
    tool: "invalid tool",
    name: "Broken Tool",
    description: "This spec is invalid on purpose.",
    auth: {
      type: "bearer_token",
      description: "Broken auth",
    },
    connection: {
      base_url: "https://example.com",
    },
    resources: {
      broken: {
        description: "Broken resource",
        operations: {
          get: {
            description: "Broken op",
            when_to_use: "Never",
            primitive: "http",
            method: "GET",
            path: "/broken/{id}",
            response: {
              description: "Nothing",
            },
          },
        },
      },
    },
  };
}

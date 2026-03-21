import type { ToolSpec } from "./types.ts";

export const GITHUB_TRUSTED_SPEC: ToolSpec = {
  spec_version: "0.1",
  tool: "github",
  name: "GitHub",
  description:
    "Interact with GitHub repositories and issues. Use this tool for issue lookup, issue creation, and other repository workflows when a dedicated local primitive is not enough.",
  docs_url: "https://docs.github.com/en/rest/issues/issues",
  auth: {
    type: "bearer_token",
    description: "GitHub Personal Access Token. Requires repo scope for private repositories.",
    env_var: "GITHUB_TOKEN",
  },
  connection: {
    base_url: "https://api.github.com",
    default_headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    rate_limit: {
      requests: 5000,
      period: "hour",
      strategy: "respect_headers",
      retry_after_header: "X-RateLimit-Reset",
    },
  },
  memory_keys: {
    default_repo: {
      description: "The owner/repo the user works with most often.",
    },
  },
  resources: {
    issues: {
      description: "GitHub issues for bugs, tasks, and feature requests.",
      operations: {
        list: {
          description: "List issues in a repository.",
          when_to_use:
            "Use when you need to inspect issues in a repository, optionally filtered by state or labels.",
          primitive: "http",
          method: "GET",
          path: "/repos/{owner}/{repo}/issues",
          params: {
            owner: {
              in: "path",
              type: "string",
              required: true,
              description: "Repository owner.",
            },
            repo: {
              in: "path",
              type: "string",
              required: true,
              description: "Repository name.",
            },
            state: {
              in: "query",
              type: "string",
              required: false,
              default: "open",
              enum: ["open", "closed", "all"],
              description: "Issue state filter.",
            },
            per_page: {
              in: "query",
              type: "integer",
              required: false,
              default: 30,
              description: "Results per page, up to 100.",
            },
          },
          response: {
            description: "Array of issue summaries.",
            important_fields: {
              "[].number": "integer - issue number.",
              "[].title": "string - issue title.",
              "[].state": "string - open or closed.",
              "[].html_url": "string - browser URL for the issue.",
            },
          },
          pagination: {
            type: "cursor",
            mechanism: "link_header",
            has_more: "Check for rel=\"next\" in the Link header.",
            next_page: "Follow the rel=\"next\" URL from the Link header.",
            max_per_page: 100,
            per_page_param: "per_page",
          },
        },
        get: {
          description: "Get a single issue by number.",
          when_to_use: "Use when you need the full details of a specific issue.",
          primitive: "http",
          method: "GET",
          path: "/repos/{owner}/{repo}/issues/{issue_number}",
          params: {
            owner: {
              in: "path",
              type: "string",
              required: true,
              description: "Repository owner.",
            },
            repo: {
              in: "path",
              type: "string",
              required: true,
              description: "Repository name.",
            },
            issue_number: {
              in: "path",
              type: "integer",
              required: true,
              description: "Issue number.",
            },
          },
          response: {
            description: "Full issue details.",
            important_fields: {
              number: "integer - issue number.",
              title: "string - issue title.",
              body: "string - issue markdown body.",
              state: "string - open or closed.",
              html_url: "string - browser URL for the issue.",
            },
          },
          errors: {
            "404": {
              meaning: "The issue was not found.",
              recovery: "Verify the owner, repo, and issue_number. Private repos require a valid token.",
            },
          },
        },
        create: {
          description: "Create a new issue.",
          when_to_use: "Use when the user explicitly wants a new GitHub issue created in a repository.",
          primitive: "http",
          method: "POST",
          path: "/repos/{owner}/{repo}/issues",
          side_effects: {
            description: "Creates a visible GitHub issue in the target repository and notifies watchers/subscribers.",
            reversible: true,
          },
          params: {
            owner: {
              in: "path",
              type: "string",
              required: true,
              description: "Repository owner.",
            },
            repo: {
              in: "path",
              type: "string",
              required: true,
              description: "Repository name.",
            },
          },
          body: {
            content_type: "application/json",
            fields: {
              title: {
                type: "string",
                required: true,
                description: "Issue title.",
              },
              body: {
                type: "string",
                required: false,
                description: "Issue description in markdown.",
              },
              labels: {
                type: "array",
                required: false,
                description: "Optional label names to apply.",
              },
              assignees: {
                type: "array",
                required: false,
                description: "Optional GitHub usernames to assign.",
              },
            },
          },
          response: {
            description: "The created issue.",
            important_fields: {
              number: "integer - issue number.",
              title: "string - issue title.",
              state: "string - open.",
              html_url: "string - browser URL for the new issue.",
            },
          },
          errors: {
            "422": {
              meaning: "Validation failed for the new issue.",
              recovery: "Check the title and any optional fields, then retry with valid values.",
            },
          },
        },
      },
    },
  },
};

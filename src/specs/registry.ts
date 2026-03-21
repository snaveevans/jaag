import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDeclaration } from "../llm/types.ts";
import { GITHUB_TRUSTED_SPEC } from "./github-spec.ts";
import { loadToolSpecFile, parseToolSpecInput } from "./loader.ts";
import type {
  LoadedToolSpec,
  OperationRegistration,
  RegisteredToolSpec,
  ToolFieldSpec,
  ToolManifest,
  ToolOperationSpec,
  ToolParamSpec,
  ToolSpec,
  TrustTier,
} from "./types.ts";
import { validateToolSpec } from "./validator.ts";

const TRUST_TIERS: TrustTier[] = ["trusted", "user-reviewed", "untrusted"];

export interface ToolSpecRegistryOptions {
  agentHome: string;
  seedTrustedSpecs?: boolean;
}

export interface ToolListFilters {
  trustTier?: TrustTier;
  name?: string;
}

export class ToolSpecRegistry {
  private readonly agentHome: string;
  private readonly specsByTool = new Map<string, RegisteredToolSpec>();
  private readonly operationsByCanonicalName = new Map<string, OperationRegistration & { registeredSpec: RegisteredToolSpec }>();
  private readonly operationsByProviderName = new Map<string, OperationRegistration & { registeredSpec: RegisteredToolSpec }>();

  constructor(options: ToolSpecRegistryOptions) {
    this.agentHome = options.agentHome;
    ensureToolDirectories(this.agentHome);

    if (options.seedTrustedSpecs !== false) {
      seedTrustedSpec(this.agentHome, GITHUB_TRUSTED_SPEC);
    }

    this.reload();
  }

  reload(): void {
    this.specsByTool.clear();
    this.operationsByCanonicalName.clear();
    this.operationsByProviderName.clear();

    for (const trustTier of TRUST_TIERS) {
      const directory = getToolsDirectory(this.agentHome, trustTier);
      const fileNames = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

      for (const fileName of fileNames) {
        const sourcePath = join(directory, fileName);
        const spec = loadToolSpecFile(sourcePath);
        this.registerLoadedSpec({ spec, sourcePath, trustTier });
      }
    }
  }

  getToolDeclarations(): ToolDeclaration[] {
    return [...this.operationsByCanonicalName.values()]
      .map((entry) => entry.declaration)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listToolManifests(filters: ToolListFilters = {}): ToolManifest[] {
    const nameFilter = filters.name?.trim().toLowerCase();

    return [...this.specsByTool.values()]
      .filter((registeredSpec) => {
        if (filters.trustTier && registeredSpec.trustTier !== filters.trustTier) {
          return false;
        }

        if (!nameFilter) {
          return true;
        }

        return registeredSpec.spec.tool.toLowerCase().includes(nameFilter)
          || registeredSpec.spec.name.toLowerCase().includes(nameFilter);
      })
      .map((registeredSpec) => ({
        tool: registeredSpec.spec.tool,
        name: registeredSpec.spec.name,
        description: registeredSpec.spec.description,
        specVersion: registeredSpec.spec.spec_version,
        trustTier: registeredSpec.trustTier,
        docsUrl: registeredSpec.spec.docs_url,
        operationCount: registeredSpec.operations.length,
        operations: registeredSpec.operations.map((operation) => `${operation.resourceName}.${operation.operationName}`),
      }))
      .sort((left, right) => left.tool.localeCompare(right.tool));
  }

  getToolSpec(toolOrName: string): RegisteredToolSpec | null {
    const directMatch = this.specsByTool.get(toolOrName);
    if (directMatch) {
      return directMatch;
    }

    const normalized = toolOrName.trim().toLowerCase();
    for (const registeredSpec of this.specsByTool.values()) {
      if (registeredSpec.spec.name.toLowerCase() === normalized) {
        return registeredSpec;
      }
    }

    return null;
  }

  getOperation(canonicalOrProviderName: string): (OperationRegistration & { registeredSpec: RegisteredToolSpec }) | null {
    return this.operationsByCanonicalName.get(canonicalOrProviderName)
      ?? this.operationsByProviderName.get(canonicalOrProviderName)
      ?? null;
  }

  registerUntrustedSpec(input: unknown): RegisteredToolSpec {
    const spec = parseToolSpecInput(input);
    const sourcePath = join(getToolsDirectory(this.agentHome, "untrusted"), `${spec.tool}.json`);
    const tempPath = join(getToolsDirectory(this.agentHome, "untrusted"), `.${spec.tool}.${crypto.randomUUID()}.tmp`);
    const existing = this.specsByTool.get(spec.tool);

    const registeredSpec = this.prepareRegisteredSpec(
      {
        spec,
        sourcePath,
        trustTier: "untrusted",
      },
      { replacingToolId: existing?.spec.tool },
    );

    try {
      writeFileSync(tempPath, JSON.stringify(spec, null, 2), "utf8");
      renameSync(tempPath, sourcePath);
    } finally {
      if (existsSync(tempPath)) {
        rmSync(tempPath, { force: true });
      }
    }

    if (existing) {
      this.unregisterSpec(existing);
    }

    return this.commitRegisteredSpec(registeredSpec);
  }

  validateSpec(input: unknown) {
    const parsedInput = typeof input === "string" ? JSON.parse(input) as unknown : input;
    return validateToolSpec(parsedInput);
  }

  private registerLoadedSpec(loadedSpec: LoadedToolSpec): RegisteredToolSpec {
    return this.commitRegisteredSpec(this.prepareRegisteredSpec(loadedSpec));
  }

  private prepareRegisteredSpec(
    loadedSpec: LoadedToolSpec,
    options: { replacingToolId?: string } = {},
  ): RegisteredToolSpec {
    const replacingToolId = options.replacingToolId;

    if (this.specsByTool.has(loadedSpec.spec.tool) && loadedSpec.spec.tool !== replacingToolId) {
      throw new Error(`Duplicate tool id loaded: ${loadedSpec.spec.tool}`);
    }

    const operations = buildOperationRegistrations(loadedSpec.spec);
    const registeredSpec: RegisteredToolSpec = {
      ...loadedSpec,
      operations,
    };

    for (const operation of operations) {
      const canonicalExisting = this.operationsByCanonicalName.get(operation.canonicalName);
      if (canonicalExisting && canonicalExisting.registeredSpec.spec.tool !== replacingToolId) {
        throw new Error(`Duplicate canonical tool operation loaded: ${operation.canonicalName}`);
      }

      const providerExisting = this.operationsByProviderName.get(operation.providerName);
      if (providerExisting && providerExisting.registeredSpec.spec.tool !== replacingToolId) {
        throw new Error(`Duplicate provider-safe tool operation loaded: ${operation.providerName}`);
      }
    }

    return registeredSpec;
  }

  private commitRegisteredSpec(registeredSpec: RegisteredToolSpec): RegisteredToolSpec {
    for (const operation of registeredSpec.operations) {
      const entry = {
        ...operation,
        registeredSpec,
      };
      this.operationsByCanonicalName.set(operation.canonicalName, entry);
      this.operationsByProviderName.set(operation.providerName, entry);
    }

    this.specsByTool.set(registeredSpec.spec.tool, registeredSpec);
    return registeredSpec;
  }

  private unregisterSpec(registeredSpec: RegisteredToolSpec): void {
    this.specsByTool.delete(registeredSpec.spec.tool);
    for (const operation of registeredSpec.operations) {
      this.operationsByCanonicalName.delete(operation.canonicalName);
      this.operationsByProviderName.delete(operation.providerName);
    }
  }
}

export function getToolsDirectory(agentHome: string, trustTier: TrustTier): string {
  return join(agentHome, "tools", trustTier);
}

export function ensureToolDirectories(agentHome: string): void {
  for (const trustTier of TRUST_TIERS) {
    mkdirSync(getToolsDirectory(agentHome, trustTier), { recursive: true });
  }
}

export function toCanonicalOperationName(toolId: string, resourceName: string, operationName: string): string {
  return `${toolId}.${resourceName}.${operationName}`;
}

export function toProviderSafeToolName(canonicalName: string): string {
  const replaced = canonicalName.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return replaced;
}

function buildOperationRegistrations(spec: ToolSpec): OperationRegistration[] {
  const operations: OperationRegistration[] = [];

  for (const [resourceName, resource] of Object.entries(spec.resources)) {
    for (const [operationName, operation] of Object.entries(resource.operations)) {
      const canonicalName = toCanonicalOperationName(spec.tool, resourceName, operationName);
      const providerName = toProviderSafeToolName(canonicalName);
      operations.push({
        canonicalName,
        providerName,
        toolId: spec.tool,
        resourceName,
        operationName,
        operation,
        declaration: buildOperationDeclaration(canonicalName, providerName, operation),
      });
    }
  }

  return operations.sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
}

function buildOperationDeclaration(
  canonicalName: string,
  providerName: string,
  operation: ToolOperationSpec,
): ToolDeclaration {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [paramName, param] of Object.entries(operation.params ?? {})) {
    properties[paramName] = fieldSpecToJsonSchema(param, param.description);
    if (param.required) {
      required.push(paramName);
    }
  }

  for (const [fieldName, field] of Object.entries(operation.body?.fields ?? {})) {
    if (properties[fieldName]) {
      throw new Error(`Operation ${canonicalName} has duplicate param/body field name: ${fieldName}`);
    }

    properties[fieldName] = fieldSpecToJsonSchema(field, field.description);
    if (field.required) {
      required.push(fieldName);
    }
  }

  return {
    name: canonicalName,
    providerName,
    description: `${operation.description} ${operation.when_to_use}`,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function fieldSpecToJsonSchema(field: ToolParamSpec | ToolFieldSpec, description: string): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: field.type === "array" ? "array" : field.type,
    description,
  };

  if (field.type === "array") {
    schema.items = {};
  }

  if (field.enum) {
    schema.enum = field.enum;
  }

  if (field.default !== undefined) {
    schema.default = field.default;
  }

  return schema;
}

function seedTrustedSpec(agentHome: string, spec: ToolSpec): void {
  const targetPath = join(getToolsDirectory(agentHome, "trusted"), `${spec.tool}.json`);
  if (existsSync(targetPath)) {
    return;
  }

  writeFileSync(targetPath, JSON.stringify(spec, null, 2), "utf8");
}

export function readRegisteredSpecFile(filePath: string): ToolSpec {
  return parseToolSpecInput(readFileSync(filePath, "utf8"));
}

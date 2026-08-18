import type { z } from 'zod';
import type { ModelToolDefinition } from '../provider.js';

/**
 * Every tool is classified by what it can do to the user's world. The classification, not the
 * model's intent, decides whether a call executes immediately or becomes a proposal.
 *
 * - `read`: returns information the user already has access to. Runs automatically.
 * - `suggest`: produces a proposal (a plan, a draft). Never changes anything on its own.
 * - `write`: changes Scalar or an external system. Requires explicit approval.
 */
export type ToolClassification = 'read' | 'suggest' | 'write';

export interface ToolContext {
  workspaceId: string;
  userId: string;
  /** Local date in the user's zone, YYYY-MM-DD. */
  today: string;
  timeZone: string;
}

/**
 * Implementations live in the API, which owns the database and the permission checks. The AI
 * package only knows the shape.
 */
export type ToolExecutor<Input, Output> = (input: Input, context: ToolContext) => Promise<Output>;

export interface ScalarTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  classification: ToolClassification;
  /** Validated before anything is executed. Model output is never trusted. */
  input: z.ZodType<Input>;
  /** JSON Schema handed to the model. */
  jsonSchema: Record<string, unknown>;
  /**
   * Renders an approval prompt for `suggest` and `write` tools: what the user is agreeing to,
   * in their words rather than the model's.
   */
  describeAction?: (input: Input) => string;
  execute: ToolExecutor<Input, Output>;
}

export type AnyScalarTool = ScalarTool<never>;

export interface DefineToolOptions<Input, Output> {
  name: string;
  description: string;
  classification: ToolClassification;
  input: z.ZodType<Input>;
  jsonSchema: Record<string, unknown>;
  describeAction?: (input: Input) => string;
  execute: ToolExecutor<Input, Output>;
}

export function defineTool<Input, Output>(
  options: DefineToolOptions<Input, Output>,
): ScalarTool<Input, Output> {
  if (options.classification !== 'read' && !options.describeAction) {
    throw new Error(`tool ${options.name}: suggest and write tools must provide describeAction`);
  }
  return options;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyScalarTool>();

  constructor(tools: AnyScalarTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: AnyScalarTool): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyScalarTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyScalarTool[] {
    return [...this.tools.values()];
  }

  /** Tool definitions for the model, in a stable order so prompt caching keeps working. */
  definitions(): ModelToolDefinition[] {
    return this.list()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.jsonSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Convenience for building a JSON Schema object with the strictness the API expects. */
export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

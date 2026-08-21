import { z } from "zod";

/**
 * Zod schemas for a tool's arguments. `in` shapes what the model sends (and
 * derives the LLM-facing JSON schema); `out` is what `execute` receives after
 * validation. Keeping them separate means `in` stays plain JSON-schema-able
 * while `out` may transform, normalize, or narrow.
 */
export interface ToolSchema<TOut, TIn> {
  /** What the model sends — derives the LLM-facing JSON schema. */
  in: z.ZodType<TIn>;
  /** What `execute` receives, validated at run time. Defaults to `in`. */
  out?: z.ZodType<TOut>;
}

export interface ToolOptions<TOut, TResult, TIn> {
  name: string;
  description: string;
  /**
   * Zod schemas for the tool arguments — the single source of truth: `in`
   * derives the LLM-facing JSON schema (`parameters`), and `out` (defaulting
   * to `in`) validates the arguments at `execute()` time, so a model sending
   * garbage surfaces a clear tool error instead of a crash inside the tool.
   * Mutually exclusive with `parameters`.
   */
  schema?: ToolSchema<TOut, TIn>;
  /** JSON schema describing the arguments for the LLM (no runtime validation). */
  parameters?: Record<string, unknown>;
  execute: (args: TOut) => TResult | Promise<TResult>;
}

/**
 * A capability exposed by the application to an agent.
 *
 * Tools execute in the application's backend: Pipeflow never runs
 * application code directly.
 */
export class Tool<TOut = Record<string, unknown>, TResult = unknown, TIn = TOut> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown> | undefined;
  // Widened to a generic-free parse function: holding `z.ZodType<...>` typed
  // against the class generics directly would make Tool invariant in its type
  // parameters and break the `Tool<{ city }, string>` → `Tool<never, unknown>`
  // assignability agents rely on.
  private readonly parse: ((args: unknown) => unknown) | undefined;
  private readonly executor: (args: TOut) => TResult | Promise<TResult>;

  constructor(options: ToolOptions<TOut, TResult, TIn>) {
    const name = options.name.trim();
    if (!name) {
      throw new Error("Tool requires a non-empty name");
    }
    const description = options.description.trim();
    if (!description) {
      throw new Error("Tool requires a non-empty description");
    }
    if (options.schema !== undefined && options.parameters !== undefined) {
      throw new Error(
        `${name}: pass either schema or parameters, not both — schema derives the LLM schema`,
      );
    }
    this.name = name;
    this.description = description;
    if (options.schema !== undefined) {
      // Single source of truth: the LLM sees exactly what execute validates.
      // `in` is always plain (transforms live on `out`), so this never throws.
      const jsonSchema = z.toJSONSchema(options.schema.in) as Record<string, unknown>;
      delete jsonSchema.$schema;
      this.parameters = jsonSchema;
      const schema = options.schema.out ?? options.schema.in;
      this.parse = (args: unknown): unknown => {
        const result = schema.safeParse(args as TIn);
        if (!result.success) {
          const details = result.error.issues
            .map((issue) =>
              issue.path.length > 0
                ? `${issue.path.join(".")}: ${issue.message}`
                : issue.message,
            )
            .join("; ");
          throw new Error(`${name}: invalid arguments: ${details}`);
        }
        return result.data;
      };
    } else {
      this.parameters = options.parameters;
      this.parse = undefined;
    }
    this.executor = options.execute;
  }

  /** Execute the tool. Sync throws and rejections both surface as rejections. */
  async execute(args: TIn): Promise<TResult> {
    const parsed = this.parse !== undefined ? this.parse(args) : args;
    return this.executor(parsed as TOut);
  }
}

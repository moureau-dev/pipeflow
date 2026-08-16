export interface ToolOptions<TArgs, TResult> {
  name: string;
  description: string;
  /** JSON schema describing the arguments for the LLM. */
  parameters?: Record<string, unknown>;
  execute: (args: TArgs) => TResult | Promise<TResult>;
}

/**
 * A capability exposed by the application to an agent.
 *
 * Tools execute in the application's backend: Pipeflow never runs
 * application code directly.
 */
export class Tool<TArgs = Record<string, unknown>, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown> | undefined;
  private readonly executor: (args: TArgs) => TResult | Promise<TResult>;

  constructor(options: ToolOptions<TArgs, TResult>) {
    const name = options.name.trim();
    if (!name) {
      throw new Error("Tool requires a non-empty name");
    }
    const description = options.description.trim();
    if (!description) {
      throw new Error("Tool requires a non-empty description");
    }
    this.name = name;
    this.description = description;
    this.parameters = options.parameters;
    this.executor = options.execute;
  }

  /** Execute the tool. Sync throws and rejections both surface as rejections. */
  async execute(args: TArgs): Promise<TResult> {
    return this.executor(args);
  }
}

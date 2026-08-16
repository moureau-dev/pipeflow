export class Tool<TArgs, TResult> {
  readonly name: string;
  readonly description: string;

  execute(args: TArgs): Promise<TResult> {
    throw new Error("Method not implemented.");
  }
}

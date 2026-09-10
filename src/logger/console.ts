import type { Logger } from "./types";

export class ConsoleLogger implements Logger {
  private readonly prefix: string;

  constructor(name?: string) {
    this.prefix = name ? `[pipeflow:${name}]` : "[pipeflow]";
  }

  info(message: string, meta?: Record<string, unknown>): void {
    const parts = [`${this.prefix} ${message}`];
    if (meta && Object.keys(meta).length > 0) parts.push(JSON.stringify(meta));
    console.log(parts.join(" "));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    const parts = [`${this.prefix} ${message}`];
    if (meta && Object.keys(meta).length > 0) parts.push(JSON.stringify(meta));
    console.warn(parts.join(" "));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    const parts = [`${this.prefix} ${message}`];
    if (meta && Object.keys(meta).length > 0) parts.push(JSON.stringify(meta));
    console.error(parts.join(" "));
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    const parts = [`${this.prefix} ${message}`];
    if (meta && Object.keys(meta).length > 0) parts.push(JSON.stringify(meta));
    console.debug(parts.join(" "));
  }
}

export class SilentLogger implements Logger {
  info(_message: string, _meta?: Record<string, unknown>): void {}
  warn(_message: string, _meta?: Record<string, unknown>): void {}
  error(_message: string, _meta?: Record<string, unknown>): void {}
  debug(_message: string, _meta?: Record<string, unknown>): void {}
}
// CLI wrapper over ToolModeBenchmark: availability + latency percentiles +
// cost per tool-call mode for one or more models.
//
//   RUNS=3 MODELS="meta-llama/llama-4-scout,amazon/nova-micro-v1" \
//     bun scripts/envelope-vs-native.ts

import { ToolModeBenchmark } from "../src/providers/llm/toolmode/toolmode";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(1);
}
// Narrowed const so hoisted functions below see a string, not string|undefined.
const KEY = apiKey;

const MODELS = (
  process.env.MODELS ??
  "meta-llama/llama-4-scout,google/gemini-2.5-flash-lite,amazon/nova-micro-v1"
).split(",");
const RUNS = Number(process.env.RUNS ?? 3);

function fmtCost(cost: number | undefined): string {
  return cost !== undefined ? `$${cost.toFixed(6)}` : "—";
}

console.log(`envelope vs native vs prompted — ${RUNS} runs per model (latency + cost)`);
for (const model of MODELS) {
  const bench = new ToolModeBenchmark({ apiKey: KEY, model, runs: RUNS });
  const result = await bench.run();
  const pIn = result.pricing ? (result.pricing.in * 1e6).toFixed(3) : "?";
  const pOut = result.pricing ? (result.pricing.out * 1e6).toFixed(3) : "?";
  console.log(`\n${model}  ($ ${pIn}/1M in, $ ${pOut}/1M out)`);

  for (const mode of ["native", "envelope", "prompted"] as const) {
    const entry = result.report[mode]!;
    if (entry.errors === entry.runs.length && entry.error !== undefined) {
      console.log(`  ${mode.padEnd(9)} ✗ ${entry.error}`);
      continue;
    }
    const time = entry.time !== undefined ? `${Math.round(entry.time.p50)}/${Math.round(entry.time.p90)}/${Math.round(entry.time.p99)}` : "—";
    console.log(
      `  ${mode.padEnd(9)} p50/p90/p99 ${time}ms  ${fmtCost(entry.cost)}  (${entry.toolCalls}/${entry.runs.length} tool-calls)`,
    );
  }
  console.log(`  → fastest ${result.fastest ?? "—"}, cheapest ${result.cheapest ?? "—"}`);
}

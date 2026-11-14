// A stand-in for the mind's `itx.config.routeCall` (its config repo's call-lines.ts): a table of the
// mind's lines, each "sales" or "default", and every routeCall the bridge made.
import { randomUUID } from "node:crypto";

export function pretendRoutes(options: {
  lines: string[];
  sales: string[];
  instructions: () => string;
  openings?: Record<string, string>;
}) {
  const asked: { line: string; from: string }[] = [];
  const routeCall = async (input: { line: string; from: string }) => {
    asked.push(input);
    const line = input.line.replace(/\D/g, "");
    if (!options.lines.includes(line))
      throw new Error(`not one of the mind's numbers: ${input.line}`);
    const from = input.from.replace(/\D/g, "");
    if (options.sales.includes(line)) {
      const instructions = options.instructions();
      return {
        mode: "sales",
        profile: "sales",
        client: `phone-sales-${randomUUID()}`,
        instructions,
        opening: /^## Opening\r?\n\r?\n> (.+)$/m.exec(instructions)?.[1] ?? "",
        source: "sales-calls.md",
      };
    }
    return {
      mode: "default",
      profile: "default",
      client: from ? `phone-${from}` : null,
      opening: options.openings?.[from] ?? options.openings?.default ?? null,
    };
  };
  return { asked, routeCall };
}

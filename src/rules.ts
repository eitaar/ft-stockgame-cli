import { RULES } from './config.js';

export type Order = Record<string, number>;

export interface OrderValidation {
  errors: string[];
  sum: number;
}

/** Validate a picks order against the game's picker rules. */
export function validateOrder(order: Order): OrderValidation {
  const entries = Object.entries(order);
  const errors: string[] = [];
  const sum = entries.reduce((a, [, p]) => a + Number(p), 0);
  if (entries.length < RULES.minPicks) errors.push(`too few picks: ${entries.length} < ${RULES.minPicks}`);
  if (entries.length > RULES.maxPicks) errors.push(`too many picks: ${entries.length} > ${RULES.maxPicks}`);
  for (const [eid, pct] of entries) {
    if (pct < RULES.minPickPct || pct > RULES.maxPickPct)
      errors.push(`${eid}: ${pct}% outside ${RULES.minPickPct}-${RULES.maxPickPct}%`);
  }
  if (sum < RULES.minInvestedPct) errors.push(`invested ${sum}% < ${RULES.minInvestedPct}%`);
  if (sum > RULES.maxInvestedPct) errors.push(`invested ${sum}% > ${RULES.maxInvestedPct}%`);
  return { errors, sum };
}

/** Parse `"S4=11,S2=8"` (or `"4=11"`) into an order map. */
export function parseOrderSpec(spec: string): Order {
  const order: Order = {};
  for (const part of spec.split(',')) {
    const [rawEid, rawPct] = part.split('=').map((s) => s.trim());
    if (!rawEid || rawPct === undefined) throw new Error(`bad pick "${part}" (expected eid=pct)`);
    order[/^S\d+$/.test(rawEid) ? rawEid : `S${rawEid}`] = Number(rawPct);
  }
  return order;
}

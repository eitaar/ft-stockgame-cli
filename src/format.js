export function money(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signedPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const v = Number(n) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length), 0),
  );
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

export function ts(seconds) {
  if (!seconds) return '-';
  return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

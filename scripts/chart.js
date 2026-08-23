/**
 * Horizontal bar charts as standalone SVG.
 *
 * Written by hand rather than pulled from a charting library: the output has to
 * render inside GitHub's markdown, which strips <style> and scripts, and it has
 * to be legible on both the light and dark themes. Every colour here is chosen
 * to carry enough contrast against white and against #0d1117.
 */

const LABEL = '#7d8590'; // readable on both themes
const TRACK = '#57606a26';

export const STATUS_COLORS = {
  merged: '#8250df',
  open: '#1a7f37',
  draft: '#6e7781',
  closed: '#cf222e',
};

const PALETTE = ['#0969da', '#8250df', '#1a7f37', '#bc4c00', '#cf222e', '#1b7c83', '#6e7781'];

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * @param {{label: string, value: number, color?: string}[]} rows
 * @param {{title?: string, width?: number, labelWidth?: number}} [opts]
 */
export function barChart(rows, opts = {}) {
  const width = opts.width ?? 720;
  const labelWidth = opts.labelWidth ?? 200;
  const rowHeight = 30;
  const barHeight = 16;
  const top = opts.title ? 34 : 8;
  const height = top + rows.length * rowHeight + 8;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const trackWidth = width - labelWidth - 60;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
  ];

  if (opts.title) {
    parts.push(
      `<text x="0" y="18" font-size="14" font-weight="600" fill="${LABEL}">${esc(opts.title)}</text>`,
    );
  }

  rows.forEach((row, i) => {
    const y = top + i * rowHeight;
    const w = Math.max(2, Math.round((row.value / max) * trackWidth));
    const color = row.color || PALETTE[i % PALETTE.length];
    parts.push(
      `<text x="${labelWidth - 10}" y="${y + barHeight - 3}" text-anchor="end" font-size="12" fill="${LABEL}">${esc(row.label)}</text>`,
      `<rect x="${labelWidth}" y="${y}" width="${trackWidth}" height="${barHeight}" rx="3" fill="${TRACK}"/>`,
      `<rect x="${labelWidth}" y="${y}" width="${w}" height="${barHeight}" rx="3" fill="${color}"/>`,
      `<text x="${labelWidth + w + 8}" y="${y + barHeight - 3}" font-size="12" font-weight="600" fill="${LABEL}">${row.value}</text>`,
    );
  });

  parts.push('</svg>');
  return parts.join('\n');
}

/** A single stacked bar, for showing outcome proportions in one line. */
export function stackedBar(rows, opts = {}) {
  const width = opts.width ?? 720;
  const barHeight = 22;
  const height = barHeight + 30;
  const total = rows.reduce((sum, r) => sum + r.value, 0) || 1;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
  ];

  let x = 0;
  for (const row of rows) {
    if (!row.value) continue;
    const w = Math.round((row.value / total) * width);
    parts.push(`<rect x="${x}" y="0" width="${w}" height="${barHeight}" fill="${row.color}"/>`);
    x += w;
  }

  let legendX = 0;
  for (const row of rows) {
    if (!row.value) continue;
    parts.push(
      `<rect x="${legendX}" y="${barHeight + 10}" width="9" height="9" rx="2" fill="${row.color}"/>`,
      `<text x="${legendX + 14}" y="${barHeight + 19}" font-size="12" fill="${LABEL}">${esc(row.label)} ${row.value}</text>`,
    );
    legendX += 22 + String(`${row.label} ${row.value}`).length * 6.6;
  }

  parts.push('</svg>');
  return parts.join('\n');
}

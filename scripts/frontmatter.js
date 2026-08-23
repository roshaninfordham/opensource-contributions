/** Minimal YAML frontmatter reader for contribution writeups. */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(source) {
  const match = FENCE.exec(source);
  if (!match) return { data: {}, body: source.trim() };

  const data = {};
  let key = null;
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (/^\s/.test(raw) && key) {
      data[key] = `${data[key]} ${raw.trim()}`.trim();
      continue;
    }
    const sep = raw.indexOf(':');
    if (sep === -1) continue;
    key = raw.slice(0, sep).trim();
    const value = raw.slice(sep + 1).trim();
    data[key] =
      value.startsWith('[') && value.endsWith(']')
        ? value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : value.replace(/^["']|["']$/g, '');
  }
  return { data, body: source.slice(match[0].length).trim() };
}

#!/usr/bin/env node
/** Regenerate README.md and the charts from data/contributions.json. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChart, stackedBar, STATUS_COLORS } from './chart.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(join(root, 'data', 'contributions.json'), 'utf8'));
const { external, own, user } = data;

/**
 * The landing page showcases current work; STATS.md keeps the whole record.
 * Read from data/display.yml so the cut-off is a setting rather than a rule
 * buried in this file.
 */
async function displayConfig() {
  const text = await readFile(join(root, 'data', 'display.yml'), 'utf8').catch(() => '');
  const since = /^landingSince:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const hide = [];
  const block = /^hide:\s*(\[\s*\]|\n(?:\s+-\s*.+\n?)*)/m.exec(text);
  if (block && !block[1].startsWith('[')) {
    for (const line of block[1].split(/\r?\n/)) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (item) hide.push(item[1].replace(/^["']|["']$/g, ''));
    }
  }
  return { since, hide };
}

const display = await displayConfig();
const featured = external.filter((c) => {
  if (display.hide.includes(`${c.org}/${c.repo}#${c.number}`)) return false;
  if (display.since && c.createdAt.slice(0, 10) < display.since) return false;
  return true;
});
const earlier = external.length - featured.length;

const count = (list, fn) => {
  const map = new Map();
  for (const item of list) {
    const key = fn(item);
    if (!key) continue;
    for (const k of [].concat(key)) map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};

const byState = (list, state) => list.filter((c) => c.state === state).length;

const merged = byState(external, 'merged');
const open = byState(external, 'open') + byState(external, 'draft');
const closed = byState(external, 'closed');
const orgs = new Set(external.map((c) => c.org)).size;
const linesAdded = external.reduce((n, c) => n + (c.additions || 0), 0);

// ---- charts -------------------------------------------------------------
await mkdir(join(root, 'assets'), { recursive: true });

await writeFile(
  join(root, 'assets', 'outcomes.svg'),
  stackedBar([
    { label: 'merged', value: byState(featured, 'merged'), color: STATUS_COLORS.merged },
    { label: 'open', value: byState(featured, 'open') + byState(featured, 'draft'), color: STATUS_COLORS.open },
    { label: 'closed', value: byState(featured, 'closed'), color: STATUS_COLORS.closed },
  ]),
);

// STATS.md shows the whole record, so it gets its own chart.
await writeFile(
  join(root, 'assets', 'outcomes-all.svg'),
  stackedBar([
    { label: 'merged', value: merged, color: STATUS_COLORS.merged },
    { label: 'open', value: open, color: STATUS_COLORS.open },
    { label: 'closed', value: closed, color: STATUS_COLORS.closed },
  ]),
);

await writeFile(
  join(root, 'assets', 'by-organisation.svg'),
  barChart(
    count(external, (c) => `${c.org}/${c.repo}`).map(([label, value]) => ({ label, value })),
    { title: 'Contributions by project' },
  ),
);

const categories = count(external, (c) => c.category);
await writeFile(
  join(root, 'assets', 'by-category.svg'),
  barChart(categories.map(([label, value]) => ({ label, value })), {
    title: 'Contributions by problem category',
  }),
);

const languages = count(external, (c) => c.language);
if (languages.length) {
  await writeFile(
    join(root, 'assets', 'by-language.svg'),
    barChart(languages.map(([label, value]) => ({ label, value })), { title: 'Languages' }),
  );
}

const skills = count(external, (c) => c.skills);
if (skills.length) {
  await writeFile(
    join(root, 'assets', 'by-skill.svg'),
    barChart(skills.slice(0, 12).map(([label, value]) => ({ label, value })), {
      title: 'Skills exercised',
    }),
  );
}

// ---- README: deliberately minimal -------------------------------------
const date = (iso) => (iso ? iso.slice(0, 10) : '');
const STATE_LABEL = { merged: 'merged', open: 'open', draft: 'draft', closed: 'closed' };

const items = featured
  .map((c) => {
    const name = c.folder ? `[${c.title}](${c.folder})` : c.title;
    const meta = [
      `[${c.org}/${c.repo}#${c.number}](${c.url})`,
      c.category && c.category !== 'uncategorised' ? c.category : null,
      STATE_LABEL[c.state],
      date(c.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');
    return `- **${name}**  \n  ${meta}`;
  })
  .join('\n');

const readme = `# Open Source Contributions

What I fixed, how I found it, and what I chose not to do. One writeup per
contribution — the reasoning, not just the link.

<img src="assets/outcomes.svg" alt="Contribution outcomes" width="720">

## Contributions

${items}

${earlier ? `\n${earlier} earlier contribution${earlier === 1 ? '' : 's'} ${earlier === 1 ? 'is' : 'are'} in the [full record](STATS.md).\n` : ''}
---

[Full statistics and charts](STATS.md) · [My own projects](projects/) · [How this repo works](AGENTS.md)

*Status synced from the GitHub API — last changed ${(data.updatedAt || data.syncedAt).slice(0, 10)}.*
`;

await writeFile(join(root, 'README.md'), readme);

// ---- STATS.md: everything that would clutter the landing page ----------
const rows = external
  .map((c) => {
    const title = c.folder ? `[${c.title}](${c.folder})` : c.title;
    const size = c.additions != null ? `+${c.additions}/-${c.deletions}` : '—';
    return `| ${date(c.createdAt)} | [${c.org}/${c.repo}](https://github.com/${c.org}/${c.repo}) | ${title} | ${c.category || '—'} | ${size} | \`${c.state}\` | [#${c.number}](${c.url}) |`;
  })
  .join('\n');

const stats = `# Statistics

Generated from \`data/contributions.json\`. Do not edit by hand — run \`npm run build\`.

## Contributions to projects I don't maintain

| | |
|---|---|
| Contributions | ${external.length} |
| Merged | ${merged} |
| Open | ${open} |
| Closed unmerged | ${closed} |
| Projects | ${orgs} |
| Lines added | ${linesAdded.toLocaleString()} |
| Review comments received | ${external.reduce((n, c) => n + (c.reviewComments || 0), 0)} |
| Median days to merge | ${(() => { const d = external.filter(c => c.daysToMerge != null).map(c => c.daysToMerge).sort((a,b)=>a-b); return d.length ? d[Math.floor(d.length/2)] : '—'; })()} |

<img src="assets/outcomes-all.svg" alt="Outcomes across every contribution" width="720">

| Date | Project | Contribution | Category | Size | Status | PR |
|---|---|---|---|---|---|---|
${rows}

<img src="assets/by-organisation.svg" alt="Contributions by project" width="720">

<img src="assets/by-category.svg" alt="Contributions by problem category" width="720">
${languages.length ? '\n<img src="assets/by-language.svg" alt="Languages" width="720">\n' : ''}
${skills.length ? '\n<img src="assets/by-skill.svg" alt="Skills exercised" width="720">\n' : ''}
## Why my own repositories are counted separately

A pull request to a repository I maintain is not the same thing as one accepted
by a project I don't control. Combining them would report a larger number that
anyone clicking through would immediately discount, which costs more credibility
than the number is worth.

My own open-source projects are described in [projects/](projects/).

*Last synced ${(data.updatedAt || data.syncedAt).slice(0, 10)}.*
`;

await writeFile(join(root, 'STATS.md'), stats);

console.log(`README: ${featured.length} featured of ${external.length} external`);
const built = ['outcomes', 'by-organisation', 'by-category'];
if (languages.length) built.push('by-language');
if (skills.length) built.push('by-skill');
console.log(`STATS.md + charts: ${built.join(', ')}`);

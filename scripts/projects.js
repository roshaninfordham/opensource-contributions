#!/usr/bin/env node
/**
 * Render projects/README.md from data/projects.yml, with stars, downloads, and
 * release data pulled live. Only the project list and its one-line blurb are
 * hand-maintained; every number here goes stale the moment it is written down,
 * so none of them are.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './github.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tiny reader for the flat list-of-maps shape used by data/projects.yml. */
function parseProjects(text) {
  const entries = [];
  let current = null;
  let key = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const item = /^-\s+(\w+):\s*(.*)$/.exec(raw);
    if (item) {
      if (current) entries.push(current);
      current = {};
      key = item[1];
      current[key] = item[2].trim();
      continue;
    }
    const field = /^\s+(\w+):\s*(.*)$/.exec(raw);
    if (field && current) {
      key = field[1];
      current[key] = field[2].replace(/^>\s*$/, '').trim();
      continue;
    }
    if (current && key && /^\s+\S/.test(raw)) {
      current[key] = `${current[key]} ${raw.trim()}`.trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function npmDownloads(pkg) {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${pkg}`);
    if (!res.ok) return null;
    return (await res.json()).downloads ?? null;
  } catch {
    return null;
  }
}

async function npmVersion(pkg) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}`);
    if (!res.ok) return null;
    return (await res.json())['dist-tags']?.latest ?? null;
  } catch {
    return null;
  }
}

const listed = parseProjects(await readFile(join(root, 'data', 'projects.yml'), 'utf8'));
const rows = [];

for (const entry of listed) {
  const [owner, name] = entry.repo.split('/');
  let meta = {};
  try {
    meta = await api(`/repos/${owner}/${name}`);
  } catch {
    /* keep going; a missing repo should not break the render */
  }
  rows.push({
    ...entry,
    name,
    stars: meta.stargazers_count ?? null,
    forks: meta.forks_count ?? null,
    language: meta.language ?? null,
    openIssues: meta.open_issues_count ?? null,
    pushedAt: meta.pushed_at ?? null,
    version: entry.npm ? await npmVersion(entry.npm) : null,
    downloads: entry.npm ? await npmDownloads(entry.npm) : null,
  });
}

const body = rows
  .map((p) => {
    const facts = [
      p.language,
      p.stars != null ? `${p.stars}★` : null,
      p.version ? `npm ${p.version}` : null,
      p.downloads != null ? `${p.downloads.toLocaleString()} downloads/mo` : null,
      p.pushedAt ? `updated ${p.pushedAt.slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const install = p.npm ? `\n\`\`\`bash\nnpm install ${p.npm}\n\`\`\`\n` : '';
    return `## [${p.name}](https://github.com/${p.repo})\n\n${p.blurb}\n\n${facts}\n${install}`;
  })
  .join('\n---\n\n');

await mkdir(join(root, 'projects'), { recursive: true });
await writeFile(
  join(root, 'projects', 'README.md'),
  `# My own open-source projects

Projects I maintain, as opposed to [contributions to projects I don't](../README.md).
Counted separately, and deliberately: a pull request to your own repository is not
the same thing as one accepted by a project you don't control.

Everything below except the descriptions is pulled live — see
[\`data/projects.yml\`](../data/projects.yml).

---

${body}
*Last synced ${new Date().toISOString().slice(0, 10)}.*
`,
);

console.log(`projects/README.md: ${rows.length} project(s)`);
for (const p of rows) {
  console.log(`  ${p.name}: ${p.stars ?? '?'}★  ${p.version ? `npm ${p.version}` : 'no npm'}  ${p.downloads ?? 0} dl/mo`);
}

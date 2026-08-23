#!/usr/bin/env node
/**
 * Rebuild data/contributions.json from the GitHub API.
 *
 * Live PR state comes from the API so it can never go stale; the judgement
 * fields -- category, skills, impact -- come from the frontmatter of each
 * writeup, which is the part a human maintains.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allPullRequests, pullDetail, repoLanguage } from './github.js';
import { parseFrontmatter } from './frontmatter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER = process.env.GH_USER || 'roshaninfordham';

/** Walk contributions/<org>/<repo>/<number>-<slug>/README.md for metadata. */
async function readWriteups() {
  const map = new Map();
  const base = join(root, 'contributions');
  const orgs = await readdir(base, { withFileTypes: true }).catch(() => []);

  for (const org of orgs.filter((e) => e.isDirectory())) {
    const repos = await readdir(join(base, org.name), { withFileTypes: true }).catch(() => []);
    for (const repo of repos.filter((e) => e.isDirectory())) {
      const entries = await readdir(join(base, org.name, repo.name), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.filter((e) => e.isDirectory())) {
        const path = join(base, org.name, repo.name, entry.name, 'README.md');
        const source = await readFile(path, 'utf8').catch(() => null);
        if (!source) continue;
        const { data } = parseFrontmatter(source);
        const number = Number(entry.name.split('-')[0]);
        if (!Number.isFinite(number)) continue;
        map.set(`${org.name}/${repo.name}#${number}`, {
          folder: `contributions/${org.name}/${repo.name}/${entry.name}`,
          category: data.category || 'uncategorised',
          skills: Array.isArray(data.skills) ? data.skills : [],
          language: data.language || '',
          summary: data.summary || '',
        });
      }
    }
  }
  return map;
}

function stateOf(item) {
  if (item.pull_request?.merged_at) return 'merged';
  if (item.state === 'closed') return 'closed';
  if (item.draft) return 'draft';
  return 'open';
}

const writeups = await readWriteups();
const prs = await allPullRequests(USER);
console.log(`Found ${prs.length} pull requests authored by ${USER}`);

const external = [];
const own = [];

for (const item of prs) {
  // repository_url looks like https://api.github.com/repos/<org>/<repo>
  const [org, repo] = item.repository_url.split('/repos/')[1].split('/');
  const key = `${org}/${repo}#${item.number}`;
  const detail = await pullDetail(org, repo, item.number);
  const writeup = writeups.get(key) || {};

  const record = {
    org,
    repo,
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: stateOf(item),
    createdAt: item.created_at,
    mergedAt: detail.mergedAt,
    additions: detail.additions,
    deletions: detail.deletions,
    changedFiles: detail.changedFiles,
    commits: detail.commits,
    reviewComments: detail.reviewComments,
    daysToMerge: detail.daysToMerge,
    ...writeup,
    // Live repository language wins unless the writeup states one explicitly,
    // so this never has to be maintained by hand.
    language: writeup.language && writeup.language !== 'TODO'
      ? writeup.language
      : await repoLanguage(org, repo),
  };

  (org.toLowerCase() === USER.toLowerCase() ? own : external).push(record);
}

const sortByDate = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
external.sort(sortByDate);
own.sort(sortByDate);

await mkdir(join(root, 'data'), { recursive: true });
await writeFile(
  join(root, 'data', 'contributions.json'),
  JSON.stringify({ user: USER, syncedAt: new Date().toISOString(), external, own }, null, 2) + '\n',
);

const undocumented = external.filter((c) => !c.folder);
console.log(`external: ${external.length}  own: ${own.length}`);
if (undocumented.length) {
  console.log(`\n${undocumented.length} external contribution(s) with no writeup:`);
  for (const c of undocumented) console.log(`  ${c.org}/${c.repo}#${c.number}  ${c.title}`);
  console.log(`\nScaffold one with:  npm run new -- <url>`);
}

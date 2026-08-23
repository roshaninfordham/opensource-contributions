#!/usr/bin/env node
/**
 * Scaffold a contribution writeup from a pull request URL.
 *
 *   npm run new -- https://github.com/ml-explore/mlx/pull/4378
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './github.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2];

if (!url) {
  console.error('\nUsage: npm run new -- <pull-request-url>\n');
  process.exit(1);
}

const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
if (!match) {
  console.error(`Not a pull request URL: ${url}`);
  process.exit(1);
}

const [, org, repo, number] = match;
const pr = await api(`/repos/${org}/${repo}/pulls/${number}`);

const slug = pr.title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 60);

const dir = join(root, 'contributions', org, repo, `${number}-${slug}`);
try {
  await access(join(dir, 'README.md'));
  console.error(`Already exists: contributions/${org}/${repo}/${number}-${slug}/README.md`);
  process.exit(1);
} catch {
  /* free */
}

const template = `---
title: ${pr.title}
project: ${org}/${repo}
pr: ${pr.html_url}
issue:
opened: ${pr.created_at.slice(0, 10)}
category: TODO
skills: [TODO, two-to-six]
language: TODO
summary: TODO one line on what this fixed and why it mattered
---

# ${pr.title}

**[${org}/${repo}#${number}](${pr.html_url})** · +${pr.additions}/-${pr.deletions} across ${pr.changed_files} files

TODO one paragraph: what the project is, and what this change does.

## 1. What was broken

TODO the mechanism, not the symptom. Name the invariant that was violated, and
the bug class it belongs to, so the pattern transfers.

## 2. How I found and reproduced it

TODO what you did to see it fail. Paste the real evidence — trace, output,
session — never a description of output you could paste.

## 3. What I changed, and what I chose not to

TODO the change, and why it belongs at that layer.

TODO the alternatives you rejected and why. TODO what you deliberately left out
of scope. This section is where judgement shows.

## 4. How I verified it

TODO real commands, real counts. Include the confirmation that the new test fails
without the fix.

## 5. What transferred

TODO the lesson that outlives this specific fix. What would you look for next
time, in a different codebase?
`;

await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'README.md'), template);

console.log(`
Created contributions/${org}/${repo}/${number}-${slug}/README.md

  1. Replace the TODOs, including the frontmatter
  2. npm run build
`);

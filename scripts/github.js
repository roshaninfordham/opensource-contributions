/**
 * Minimal GitHub API client. Uses GITHUB_TOKEN when present (CI), otherwise
 * falls back to the local `gh` CLI's token, so the same script works in both
 * places with no configuration.
 */
import { execSync } from 'node:child_process';

let cachedToken = null;

function token() {
  if (cachedToken !== null) return cachedToken;
  if (process.env.GITHUB_TOKEN) return (cachedToken = process.env.GITHUB_TOKEN);
  try {
    cachedToken = execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    cachedToken = '';
  }
  return cachedToken;
}

export async function api(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'opensource-contributions',
  };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Every pull request authored by `user` in a PUBLIC repository.
 *
 * `is:public` is load-bearing, not a nicety. A local token with `repo` scope can
 * see private repositories, so without it this file -- which is committed to a
 * public repo -- would carry private repository names and pull request titles.
 * CI's repo-scoped token cannot see them, so the two would also disagree forever
 * and fight over every sync.
 */
export async function allPullRequests(user) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const q = encodeURIComponent(`author:${user} type:pr is:public`);
    const data = await api(`/search/issues?q=${q}&per_page=100&page=${page}&sort=created&order=desc`);
    items.push(...data.items);
    if (items.length >= data.total_count || data.items.length === 0) break;
  }
  return items;
}

/** Size, merge, and review detail the search endpoint does not return. */
export async function pullDetail(owner, repo, number) {
  try {
    const pr = await api(`/repos/${owner}/${repo}/pulls/${number}`);
    const days =
      pr.merged_at && pr.created_at
        ? Math.round((new Date(pr.merged_at) - new Date(pr.created_at)) / 86400000)
        : null;
    return {
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      commits: pr.commits,
      reviewComments: pr.review_comments,
      comments: pr.comments,
      mergedAt: pr.merged_at,
      daysToMerge: days,
    };
  } catch {
    return {};
  }
}

const languageCache = new Map();

/** A repository's primary language, so the writeup does not have to state it. */
export async function repoLanguage(owner, repo) {
  const key = `${owner}/${repo}`;
  if (languageCache.has(key)) return languageCache.get(key);
  try {
    const data = await api(`/repos/${owner}/${repo}`);
    languageCache.set(key, data.language || '');
  } catch {
    languageCache.set(key, '');
  }
  return languageCache.get(key);
}

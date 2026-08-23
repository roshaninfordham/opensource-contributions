# Instructions for agents working in this repository

Read this before changing anything here. It applies to any AI agent — the file is
named `AGENTS.md` by convention, and `CLAUDE.md` points at it.

## What this repository is

A documented record of Roshan Sharma's open-source contributions. It is not a
list of links. The value is in the **reasoning**: what was actually broken, how it
was found, which fixes were rejected and why, and what transferred to the next
problem.

Anyone reading it should come away able to judge how this person thinks, not just
how many pull requests they have opened.

## Structure

```
README.md                     GENERATED — a chart and a list. Keep it minimal.
STATS.md                      GENERATED — tables and charts live here, not on the landing page.
projects/README.md            GENERATED — stars, versions, downloads pulled live.
data/contributions.json       GENERATED — synced from the GitHub API.
assets/*.svg                  GENERATED — charts.

contributions/<org>/<repo>/<number>-<slug>/README.md
                              HAND-WRITTEN — one writeup per contribution.
data/projects.yml             HAND-WRITTEN — which of Roshan's projects to list,
                              and one line each. Nothing else.
data/display.yml              HAND-WRITTEN — what the landing page showcases.

scripts/                      sync, render, projects, chart, scaffold.
```

**Exactly two things are hand-maintained:** the contribution writeups, and the
project list in `data/projects.yml`. Everything else is derived. If you find
yourself typing a number — a star count, a download figure, a PR state, a line
count, a language — stop: it is already available live, and a number written by
hand is wrong the day after it is written.

**Never hand-edit a generated file.** `README.md`, `STATS.md`,
`data/contributions.json`, and `assets/*.svg` are rewritten by `npm run build`
and by a scheduled workflow. Edits to them are silently destroyed. Change the
generator or the writeup instead.

## Adding a contribution

```bash
npm run new -- https://github.com/<org>/<repo>/pull/<number>
# fill in the writeup
npm run build
```

`npm run new` creates the folder and a template from the live PR. `npm run build`
re-syncs status from the API and regenerates everything downstream.

### Frontmatter

```yaml
---
title: Validate GGUF tensor dimensions
project: ml-explore/mlx
pr: https://github.com/ml-explore/mlx/pull/4378
issue: https://github.com/ml-explore/mlx/issues/4244
opened: 2026-08-23
category: memory safety          # drives the category chart — reuse existing values
skills: [C++, AddressSanitizer]  # drives the skills chart
language: C++
summary: One line on what this fixed and why it mattered.
---
```

`category` and `skills` are the only judgement fields. Everything else about the
PR — state, size, dates, commits, review comments, days to merge, and the
repository's language — comes from the API and must not be duplicated here.
`language` in the frontmatter is an override for the rare case where the
repository's primary language is not the one you worked in; leave it out
otherwise.
Reuse existing category values rather than inventing near-synonyms, or the chart
fragments into a long tail of one-item bars.

### The five sections

Every writeup uses the same shape. Do not reorder or rename them.

1. **What was broken** — the mechanism, not the symptom. Name the invariant that
   was violated and the bug class it belongs to (integer truncation, TOCTOU,
   lifetime, race, …) so the pattern transfers to a reader's own work.
2. **How I found and reproduced it** — the evidence, pasted verbatim. Stack
   traces, sanitizer output, real sessions. If a reproducer was derived rather
   than copied, show the derivation.
3. **What I changed, and what I chose not to** — the change, why it belongs at
   that layer, the alternatives rejected with reasons, and what was deliberately
   left out of scope. This section is where judgement shows; it is the most
   important one.
4. **How I verified it** — real commands and real counts. Include confirmation
   that a new test fails without the fix.
5. **What transferred** — the lesson that outlives the specific fix. What would
   you look for next time, in a different codebase?

## Rules

**Accuracy is the whole product.** Every number, line reference, and quoted output
must be verifiable against the code or a real run. A writeup that overstates is
worse than no writeup, because the repo's only asset is that a reader trusts it.
Check claims against the source before writing them down.

**Do not inflate.** Contributions to projects Roshan does not maintain are counted
separately from his own repositories, and the landing page shows only the former.
Never merge the two counts to make a number look better. If a contribution was
closed unmerged, it stays listed as closed — the closed ones are often the more
interesting writeups.

**Keep the landing page minimal.** A chart and a list. Tables, statistics, and
secondary charts belong in `STATS.md`. If the README starts growing sections,
move them.

**The landing page showcases current work; STATS.md keeps everything.**
`data/display.yml` controls the split:

```yaml
landingSince: 2026-08-01   # only contributions from this date appear on the landing page
hide: []                   # "<org>/<repo>#<number>" entries to keep off it regardless
```

Nothing there deletes anything — every contribution stays in
`data/contributions.json` and in `STATS.md`, and the landing page says how many
earlier ones exist and links to them. Never drop a contribution from the record
to make the numbers look better, including a closed one.

**Write in Roshan's voice.** First person, technical, concise. Concrete over
abstract: real commands, real paths, real numbers. No marketing language, no
"leveraged", no emoji. State the fact and stop.

**AI use is disclosed, not hidden.** This repository is open about the fact that
AI assistance is used in the work. Do not write anything here that implies
otherwise.

## When the contribution itself is being made

That work happens in the *other* repository, not this one, and the rules there
are different and binding:

- Read that project's `CONTRIBUTING.md`, `AGENTS.md`, and `CLAUDE.md` **before
  writing code**. Some projects mandate disclosure of AI use; some prohibit
  AI-written pull request descriptions, issue text, and replies to reviewers.
  Penalties include contributor bans.
- Where a project prohibits AI-written posts, an agent must not draft the PR
  description, commit message, or any reply to a human — not even as a draft to
  be rephrased — and must not push or open the PR on the author's behalf. Hand
  over an organised record of facts instead and let the human write.
- `ml-explore/mlx` is one such project. Its policy is summarised in the writeup
  for #4378.

## Commands

```bash
npm run new -- <pr-url>   # scaffold a writeup
npm run sync              # refresh data/contributions.json from the GitHub API
npm run render            # regenerate README.md, STATS.md, assets/*.svg
npm run projects          # regenerate projects/README.md with live stars/downloads
npm run build             # all of the above
```

A scheduled workflow runs `npm run build` every six hours and commits only when
something changed, so nothing here is ever more than a few hours out of date.

`npm run build` prints any external contribution that has no writeup yet. That
list is the backlog.

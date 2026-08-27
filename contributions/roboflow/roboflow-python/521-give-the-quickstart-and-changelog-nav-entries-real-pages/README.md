---
title: Give the Quickstart and Changelog nav entries real pages
project: roboflow/roboflow-python
pr: https://github.com/roboflow/roboflow-python/pull/521
issue: https://github.com/roboflow/roboflow-python/issues/380
opened: 2026-08-27
category: developer experience
skills: [Python, mkdocs, technical writing]
summary: Two sidebar links on the published docs site pointed at files that were never written, and mkdocs had been warning about both on every build.
---

# Give the Quickstart and Changelog nav entries real pages

**[roboflow/roboflow-python#521](https://github.com/roboflow/roboflow-python/pull/521)** · +8/-0 across 4 files · fixes [#380](https://github.com/roboflow/roboflow-python/issues/380)

`roboflow-python` is the official SDK for the Roboflow platform. Its docs are
mkdocs-material, published to GitHub Pages.

## 1. What was broken

**Bug class: a declared reference with no referent — a build warning that was
never promoted to an error.**

`mkdocs.yml` listed two nav entries whose files do not exist:

```yaml
nav:
  - Home: index.md
  - Quickstart: quickstart.md      # docs/quickstart.md never existed
  ...
  - Changelog: changelog.md        # docs/changelog.md never existed
```

`docs/` contains only `index.md`, `core/`, `models/` and `styles.css`. mkdocs does
not fail on this; it warns and publishes the sidebar anyway, so both links shipped
as 404s and stayed that way from whenever the pages were planned.

The build had been saying so the whole time:

```
WARNING - A reference to 'quickstart.md' is included in the 'nav' configuration, which is not found in the documentation files.
WARNING - A reference to 'changelog.md' is included in the 'nav' configuration, which is not found in the documentation files.
```

Two warnings among 50 — the other 48 are pre-existing `griffe` docstring
complaints. That is the actual mechanism of this bug: **a signal that was present,
correct, and drowned.**

## 2. How I found and reproduced it

The issue is a user report with a screenshot. Reproducing it locally meant
building the site and reading the warnings rather than trusting the report:

```
$ mkdocs build
...
50 warnings
$ mkdocs build 2>&1 | grep -iE "quickstart|changelog"
WARNING - A reference to 'quickstart.md' ...
WARNING - A reference to 'changelog.md' ...
```

`--strict` aborts, but on all 50, so it cannot distinguish this defect from the
docstring noise. Counting warnings before and after turned out to be the usable
signal.

## 3. What I changed, and what I chose not to

Both pages now exist and **single-source from content already in the repository**:

- `docs/quickstart.md` pulls the README's Quickstart section via `pymdownx.snippets`,
  using `--8<-- [start:quickstart]` / `[end:quickstart]` HTML comment markers that
  render as nothing on GitHub.
- `docs/changelog.md` includes the root `CHANGELOG.md` the same way.
- `mkdocs.yml` enables `pymdownx.snippets` with `check_paths: true`, so a future
  missing include fails the build instead of silently rendering an empty page.

### Alternatives rejected

**Point the nav at an anchor: `- Quickstart: index.md#quickstart`.** `docs/index.md`
already contains a `## Quickstart` section, so this looked like the zero-content
fix. I tried it. mkdocs treats the whole string as a filename:

```
WARNING - A reference to 'index.md#quickstart' is included in the 'nav' configuration, which is not found in the documentation files.
```

Worth recording as a rejected option rather than silently not mentioning it,
because it is the first thing anyone else will also try.

**Delete the two nav lines.** Smallest possible diff and it does close the 404. But
a Python SDK reasonably has a Quickstart in its sidebar, and the content already
existed — it just was not reachable. Removing the link answers the bug report by
deleting the feature.

**Write two new hand-authored pages.** `docs/index.md` is already a copy of
`README.md`. A third copy of the quickstart is a third thing to keep in sync, and
docs that drift are how this repo got here.

### Scope left out

The 48 `griffe` warnings in `roboflow/core/` and `roboflow/models/` — real, but a
different and much larger piece of work, and mixing them in would bury an
eight-line fix.

## 4. How I verified it

Warning count before and after, and — more importantly — the rendered HTML, not
just the exit code:

```
mkdocs build     before: 50 warnings, both nav warnings present
mkdocs build     after:  48 warnings, neither present
```

```
$ grep -c "MY_API_KEY" site/quickstart/index.html    1
$ grep -c "1.4.1\|Changelog" site/changelog/index.html   12
```

A build that stops warning could equally mean the page rendered empty, which is
why the content check matters.

```
python -m unittest              970 tests, OK (skipped=1)   — unchanged
ruff check .                    All checks passed!
```

`ruff format --check` flags 3 files; it flags the same 3 on the parent commit, so
that drift is pre-existing. I verified this by checking out `HEAD~1` and re-running,
rather than by assuming — the first time I checked I had already committed, so
`git stash` was a no-op and the comparison was meaningless.

## 5. What transferred

**A warning nobody has ever driven to zero is not a signal.** Two accurate
warnings sat in every build for as long as the pages have been missing. The fix
for that class is not diligence, it is a threshold — `--strict`, or a count that
must not increase.

**Verify the artifact, not the build status.** "The build is clean" and "the page
has content on it" are different claims. Checking the rendered HTML caught nothing
this time, which is exactly when you find out the check is cheap.

**Try the tempting shortcut before rejecting it in the PR.** `index.md#quickstart`
was the obvious minimal fix and it does not work. Knowing that, and saying so, is
worth more to a reviewer than a fix that silently avoids it.

**When you compare against a baseline, make sure you are actually on the
baseline.** `git stash` on a clean tree does nothing and reports success.

---
title: Match documented dev setup and test commands to CI
project: roboflow/rf-detr
pr: https://github.com/roboflow/rf-detr/pull/1407
issue:
opened: 2026-08-27
category: developer experience
skills: [Python, uv, pytest, CI, technical writing]
summary: Following rf-detr's own CONTRIBUTING.md produced 118 failures and 210 errors; the commands had drifted from the CI workflows the file names as authoritative.
---

# Match documented dev setup and test commands to CI

**[roboflow/rf-detr#1407](https://github.com/roboflow/rf-detr/pull/1407)** · +13/-7 in 1 file

RF-DETR is Roboflow's real-time detection architecture. I was not looking for this
— I was setting up the repo to work on something else, and the setup did not work.
That is the whole point of it: the person who finds this bug is always a new
contributor, and the failure looks like a broken repository rather than a stale doc.

## 1. What was broken

**Bug class: documentation drift from an executable source of truth that the
document itself names.**

`.github/CONTRIBUTING.md` says, in a callout:

> **CI Workflows as Source of Truth:** See `.github/workflows/ci-tests-cpu.yml` and
> `.github/workflows/ci-tests-gpu.yml` for the exact commands used in continuous integration.

Three commands had drifted from the files that sentence points at.

**Install.** The doc says `uv sync --all-groups`. In uv, *groups* and *extras* are
different things — that installs no extras at all, so every test importing the
training dependencies fails on import. The obvious next thing to try makes it
worse, not better:

```
$ uv sync --all-extras
error: Extras `coreml` and `executorch` are incompatible with the declared conflicts
```

CI instead runs `uv pip install -e ".[train,augment,cli,visual]" --group tests` with
`UV_TORCH_BACKEND=cpu`, and `ci-tests-gpu.yml` even carries a comment explaining
why `uv pip` rather than `uv sync` — reasoning that never reached CONTRIBUTING.

**CPU markers.** Documented as `-m "not gpu"`. CI uses
`-m "not gpu and not coco17 and not e2e_coreml and not e2e_executorch and not e2e_roboflow and not xla and not tpu"`.
Those extra exclusions are what keep suites needing the COCO dataset, a Roboflow
API key, or an accelerator from running on a laptop.

**GPU markers.** Documented as `-m gpu`; CI uses `-m "gpu and not e2e_tensorrt"`.

## 2. How I found and reproduced it

By following the file, on a clean macOS checkout:

```
following CONTRIBUTING.md as written : 118 failed, 2529 passed, 210 errors
following ci-tests-cpu.yml           : 4406 passed, 67 skipped, 0 failed
```

The errors are uniformly `ImportError: RF-DETR training dependencies are missing`,
which reads as a broken install rather than as an incomplete instruction — the
worst kind of first-contact failure, because the natural response is to doubt your
own environment.

## 3. What I changed, and what I chose not to

Made the documented commands equal the workflows the file already declares
authoritative, and wrote down the two pieces of reasoning that only existed as a
YAML comment:

- why `uv pip install` rather than `uv sync` — the universal lock resolution fails
  across extras with different Python floors, and `UV_TORCH_BACKEND` is only
  honoured by `uv pip`
- what the extra markers exclude and why, so the list stays maintainable rather
  than looking like magic

### Alternatives rejected

**Make CI read its commands from the doc, or generate the doc from CI.** This
removes the drift permanently instead of resetting it. Rejected as out of
proportion: it is a build-tooling change to solve a paragraph, and it would need
maintainer buy-in on how the generation works.

**Fix only the marker expression.** The install command is the one that produces
the frightening output. Fixing the markers alone would leave 210 import errors in
place.

### Scope left out

I did not touch `uv sync --group docs` / `--group build`, which are correct for
docs and build work where no extras are needed.

## 4. How I verified it

Ran the commands as rewritten, from the state a new contributor would be in:

```
uv pip install -e ".[train,augment,cli,visual,coreml]" --group tests   # UV_TORCH_BACKEND=cpu, macOS
uv run --no-sync pytest src/ tests/ -n 2 \
  -m "not gpu and not coco17 and not e2e_coreml and not e2e_executorch and not e2e_roboflow and not xla and not tpu" \
  --ignore=tests/run_smoke_all_models.py --ignore=tests/legacy/test_checkpoint_compat.py --timeout=240
```
→ **4406 passed, 67 skipped** in 115s.

`pre-commit run --all-files` passes 18 hooks. `mdformat` reflowed my hard-wrapped
paragraphs to the repo's unwrapped style, which I took and re-ran. The `mypy` local
hook fails with `No module named mypy` in my environment — I checked that it fails
identically on a stashed clean tree, so it is a local artifact and not something
this change introduced, and the change touches no Python anyway.

## 5. What transferred

**A document that names a source of truth is making a testable claim.** "See the
CI workflow for the exact commands" is falsifiable in about a minute: diff the doc
against the workflow. Any repo with that sentence is worth checking, and the drift
is almost always in the direction of the doc being older.

**Setup instructions are the least-tested code in a repository.** Maintainers have
working environments and never re-run them; CI never reads them. The only person
who executes the setup path is the one least able to tell a stale doc from a broken
repo.

**Reproduce the documented path, not the working one.** My instinct was to get the
tests running and move on. The 118/210 number only exists because I went back and
ran what the file actually said. That number is what turns "the docs are a bit off"
into a reviewable defect.

**A YAML comment is not documentation.** The real reason for `uv pip` over
`uv sync` was written down — inside the workflow, where only someone already
past the problem would read it.

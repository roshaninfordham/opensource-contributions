---
title: Explain why a legacy YOLO checkpoint fails to unpickle
project: roboflow/roboflow-python
pr: https://github.com/roboflow/roboflow-python/pull/523
issue: https://github.com/roboflow/roboflow-python/issues/357
opened: 2026-08-27
category: error handling
skills: [Python, pickle, PyTorch, unittest, API design]
summary: Deploying a yolov5/v7/v9 checkpoint failed with "No module named 'models'", an error that names nothing the user owns and suggests nothing they can do.
---

# Explain why a legacy YOLO checkpoint fails to unpickle

**[roboflow/roboflow-python#523](https://github.com/roboflow/roboflow-python/pull/523)** · +50/-1 across 2 files · partially addresses [#357](https://github.com/roboflow/roboflow-python/issues/357)

`version.deploy()` uploads locally trained weights to the Roboflow platform. To do
that it has to open the checkpoint and read what is inside.

## 1. What was broken

**Bug class: an internal implementation detail escaping as an error message —
specifically, pickle-by-reference leaking its module graph to the end user.**

The issue reports two failures in sequence. The first, PyTorch 2.6 flipping
`weights_only` to `True`, is already fixed — every `torch.load` in
`model_processor.py` now passes `weights_only=False`. **Confirming that half was
already fixed is what made the remaining half worth working on**, and it is the
kind of thing that only shows up by reading the current source rather than the
issue title.

After downgrading torch, the reporter hit the live half:

```
ModuleNotFoundError: No module named 'models'
```

yolov5, yolov7 and yolov9 checkpoints pickle their model classes **by reference**
(`models.yolo`, `utils.*`) rather than by value. Pickle stores the qualified name
and re-imports it at load time, so unpickling only succeeds in an environment where
the training repository is importable. Run `deploy()` from anywhere else and pickle
fails on a module the user has no reason to associate with their own `best.pt`.

The user's mental model is "I am uploading a file." The error says a module is
missing. Nothing connects the two, and nothing suggests a remedy.

## 2. How I found and reproduced it

I did not want to assert the mechanism from the traceback, so I built a checkpoint
with the same shape: a package named `models` containing a class, pickled by
reference into a `.pt`, then loaded from a directory where `models` is not
importable.

```
checkpoint written, pickles models.yolo.DetectionModel
REPRODUCED: ModuleNotFoundError: No module named 'models'
```

Byte-for-byte the reporter's error, from a synthetic checkpoint under 20 lines —
no yolov5 clone, no real weights, no GPU. That is the moment the diagnosis stops
being a guess.

## 3. What I changed, and what I chose not to

`_load_checkpoint` is already a single chokepoint — all three call sites go through
it — and it takes the torch module as a parameter. Catch the failure there and
re-raise it as the repo's own error type, naming both the cause and the fix:

```python
except ModuleNotFoundError as error:
    raise ModelPackagingError(
        f"Could not load {checkpoint_path}: the checkpoint references the module "
        f"'{error.name}', which is not importable here. Checkpoints produced by the "
        "yolov5, yolov7 and yolov9 training repositories store their model classes by "
        "reference, so they can only be unpickled from an environment where that "
        "repository is importable. Run the upload from the training repository's "
        "directory, or add it to PYTHONPATH."
    ) from error
```

`from error` keeps the original traceback. `error.name` is used rather than a
hardcoded `"models"`, so a checkpoint referencing `utils` says `utils`.

### Alternatives rejected

**Inject the training repo into `sys.path` automatically.** This would actually
make it work rather than merely explain it. Rejected because roboflow would have to
*guess* where the user's yolov5 clone lives, and a wrong guess produces a worse
failure than the current one. I said so in the PR and offered to implement it if
the maintainers want that shape — it is a product decision about how much magic the
SDK should do.

**Catch broadly (`except Exception`).** Would swallow corrupt-archive and
permission errors into a message about YOLO training repositories, which is
actively misleading. The PR includes a test asserting a `RuntimeError` still
propagates untouched.

### Scope left out

The `weights_only` half of the issue, already fixed. I said so explicitly rather
than claiming the whole issue, so the maintainers can decide whether #357 closes
here or stays open for the `sys.path` question.

## 4. How I verified it

The helper takes `torch_module` as a parameter — dependency injection that was
already there — so the committed tests drive it with a double and need neither
torch nor a checkpoint fixture:

```
Ran 3 tests in 0.000s
OK
```

Three cases: the translation, a pass-through of a successful load asserting the
exact `torch.load` kwargs, and an unrelated exception propagating unchanged.
Against unmodified `main` the translation test errors with the untranslated
exception:

```
ModuleNotFoundError: No module named 'models'
FAILED (errors=1)
```

```
python -m unittest              before: 970 tests, OK (skipped=1)
python -m unittest              after:  973 tests, OK (skipped=1)
ruff check roboflow/ tests/     All checks passed!
```

## 5. What transferred

**"I cannot fix this" and "I cannot improve this" are different conclusions.**
Pickle-by-reference genuinely requires the defining module; that constraint is not
negotiable. The message describing the failure is entirely under our control, and
that is where the whole user cost was.

**Translate errors at the boundary the user is aware of.** The user knows about
"my checkpoint" and "the upload". They do not know about pickle's import graph. An
error that names only the latter is technically accurate and practically useless —
and `raise ... from error` costs nothing while keeping the accurate version for
whoever needs it.

**Reproduce the mechanism, not the symptom.** I could have pattern-matched
`ModuleNotFoundError` to "pickle-by-reference" from experience and been right.
Building a 20-line checkpoint that reproduces it byte-for-byte turned a confident
guess into evidence I could paste into the PR.

**Check what is already fixed before writing anything.** Half of this issue was
resolved. Had I not read the current source, I would have written a PR against a
problem that no longer exists — and the half that remained was in the comments,
not the title.

**Narrow the except.** `except Exception` around a load call turns every unrelated
failure into a confidently wrong diagnosis.

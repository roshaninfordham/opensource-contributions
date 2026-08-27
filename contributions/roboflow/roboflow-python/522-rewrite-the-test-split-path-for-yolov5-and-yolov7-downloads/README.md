---
title: Rewrite the test split path for yolov5 and yolov7 downloads
project: roboflow/roboflow-python
pr: https://github.com/roboflow/roboflow-python/pull/522
issue: https://github.com/roboflow/roboflow-python/issues/156
opened: 2026-08-27
category: correctness
skills: [Python, unittest, YAML, data pipelines]
summary: Downloading a YOLOv5/v7 dataset rewrote two of the three split paths in data.yaml and left the third pointing at a directory that does not exist.
---

# Rewrite the test split path for yolov5 and yolov7 downloads

**[roboflow/roboflow-python#522](https://github.com/roboflow/roboflow-python/pull/522)** · +49/-0 across 2 files · fixes [#156](https://github.com/roboflow/roboflow-python/issues/156)

When you download a dataset through `roboflow-python`, it unzips the export and
then rewrites the `data.yaml` that tells the training framework where each split
lives.

## 1. What was broken

**Bug class: an incomplete transformation over a set — two of three members
handled, silently.**

```python
if format == "mt-yolov6":
    content["train"] = location + content["train"].lstrip(".")
    content["val"]   = location + content["val"].lstrip(".")
    content["test"]  = location + content["test"].lstrip(".")
if format in ["yolov5pytorch", "yolov7pytorch"]:
    content["train"] = location + content["train"].lstrip("..")
    content["val"]   = location + content["val"].lstrip("..")
    # test: absent
```

The `mt-yolov6` branch immediately above handles all three. The yolov5/v7 branch
handles two, so the file that lands on disk is internally inconsistent:

```yaml
train: my-dataset-3/train/images
val:   my-dataset-3/valid/images
test:  ../test/images            # relative to the wrong directory
```

Nothing raises. Training and validation work. The failure shows up only when
someone evaluates on the test split, at which point the path resolves relative to
the process's working directory instead of the dataset root.

This is a **plain omission**, not a subtle mechanism — which makes it interesting
for a different reason. It sat open for over three years, and the reason it did is
in the next section.

## 2. How I found and reproduced it

The issue is from 2023 with a zipped `data.yaml` attached. Rather than open the
attachment, I reproduced the transformation directly: write a `data.yaml` matching
the server's export shape into a temp directory, call the private
`__reformat_yaml`, and read back what it wrote. Against unmodified `main`:

```
- ../test/images
+ /var/folders/.../tmpx2c0ibkb/test/images
FAILED (failures=2)
```

**The important discovery was not in the code, it was in the merge history.** PR
#334, "bugfix - downloading yolov8 files incorrectly amends data.yaml", merged in
October 2024, argues the exact opposite direction:

> When you export a dataset in yolov8 format from the UI, you get a correct yaml...
> But if download it with roboflow-python you get a modified yaml... It's not good
> that the train notebook needs to undo the mistake of roboflow-python

So there is a live disagreement inside the repository about whether this rewriting
should happen at all. A one-line "add the missing `test` line" PR, sent without
reading that history, walks straight into it.

## 3. What I changed, and what I chose not to

Made the branch internally consistent, and **said out loud in the PR that the other
direction is defensible**:

```python
# A version generated without a test split has no `test` key at all.
if "test" in content:
    content["test"] = location + content["test"].lstrip("..")
```

The guard is not decoration. A version generated without a test split has no
`test` key, and an unguarded assignment would turn a working download into a
`KeyError` — trading a wrong path for a crash. The `mt-yolov6` branch above has
exactly that latent bug today; I noted it in the PR and left it, because changing
it is a behaviour change nobody asked for.

### Alternatives rejected

**Remove the yolov5/v7 rewriting entirely.** This is what #334's reasoning implies,
and it may well be what the maintainers want. Rejected *for me to decide*: it
changes behaviour for every existing yolov5/v7 user, and relitigating a merged
decision is not an outside contributor's call. I offered to swap the PR to that
shape if they prefer.

**Guard `mt-yolov6` too, for symmetry.** Tempting and one line. It would mask a
`KeyError` that currently surfaces immediately, and it is not what this issue is
about.

### Scope left out

`.lstrip("..")` strips a *set of characters*, not a prefix, so it is exactly
equivalent to the `.lstrip(".")` two lines above. Harmless for these inputs, but
the two branches read as though they differ when they do not. Noted in the PR, not
changed.

## 4. How I verified it

```
python -m unittest     before: 970 tests, OK (skipped=1)
python -m unittest     after:  973 tests, OK (skipped=1)
```

Two of the three new tests fail on unmodified `main` on exactly the reported
symptom. The third — a dataset with no test split — passes either way **by
design**: it exists to pin the guard so a later change cannot reintroduce the
`KeyError`. A test that passes before and after is worth having as long as you know
which kind it is.

## 5. What transferred

**Read the merge history before fixing an old issue, not the issue.** Three years
open usually means either nobody cares or somebody disagreed. Here it was
disagreement, recorded in a merged PR that argues the opposite fix. `git log -S`
and a search of merged PRs touching the same function is ten minutes that changes
what you write.

**When two readings are defensible, ship the smaller one and name the other.**
Making one branch internally consistent is defensible under either philosophy.
Picking the philosophy is the maintainer's job, and saying "I can send the other
shape instead" costs nothing and shows you saw the fork.

**Every added dict access is a new failure mode.** The obvious one-line fix —
mirroring the branch above — would introduce a `KeyError` on datasets without a
test split. The neighbouring code being unguarded is evidence that nobody hit it
yet, not evidence that it is safe.

**Know why each test passes.** A regression test that passes before and after is
either useless or a guard. Say which in the PR, or a reviewer will assume the
first.

---
title: Merge InferenceSlicer results in source slice order
project: roboflow/supervision
pr: https://github.com/roboflow/supervision/pull/2517
issue:
opened: 2026-08-27
category: concurrency
skills: [Python, concurrency, NumPy, pytest, computer vision]
summary: Tiled inference collected thread results in completion order, so which of two overlapping detections survived NMS changed between runs on identical input.
---

# Merge InferenceSlicer results in source slice order

**[roboflow/supervision#2517](https://github.com/roboflow/supervision/pull/2517)** · +106/-13 across 3 files

`supervision` is Roboflow's computer-vision utility library — the layer between a
detection model and whatever you do with its output. `InferenceSlicer` implements
tiled inference: an image too large for a model's input resolution is cut into
overlapping tiles, the model runs on each tile, and the per-tile detections are
translated back into full-image coordinates and merged. Overlap is deliberate, so
that an object straddling a tile boundary is caught whole in at least one tile;
the duplicate detections it produces are then removed by non-maximum suppression.

The merge step collected results from its thread pool in completion order. This
change makes it collect in source order, which the method's own docstring already
promised.

## 1. What was broken

**Bug class: an unordered concurrent collection feeding an order-sensitive
consumer.**

`InferenceSlicer.__call__` states its contract explicitly. The sentence was added
deliberately — `git log -S "deterministic order"` attributes it to PR #2256:

> Detections are merged in a deterministic order: the first slice is always at
> index 0, followed by any probe slices, then the remaining slices in source order.

Both threaded paths violated the final clause. The single-slice path:

```python
with ThreadPoolExecutor(max_workers=self.thread_workers) as executor:
    futures = [
        executor.submit(self._run_callback, image, offset)
        for offset in remaining_offsets
    ]
    for future in as_completed(futures):
        detections_list.append(future.result())
```

`concurrent.futures.as_completed` yields futures **in completion order**. That is
not a defect in `as_completed` — it is the entire reason the function exists, to
hand you results the moment they arrive rather than making you wait on a slow
one. The `batch_size > 1` path had the identical shape over its batch futures.

`Detections.merge` then concatenates the list positionally, so the row order of
the returned object inherits whichever inference call happened to finish first.

Neither half is wrong in isolation. `as_completed` is correct when the consumer
is order-indifferent. Positional concatenation is correct when its input is
ordered. Composing them silently discards the ordering, and nothing raises,
because nothing here is illegal — the output is simply *a* valid answer instead
of *the* answer.

### Why it is not a row-ordering nit

Two consumers sit immediately downstream, and both are order-sensitive.

The first is the returned row order itself. Anything indexing `detections[0]`,
zipping against a parallel list, or writing `CSVSink` / `JSONSink` output gets
rows in an order that changes between runs on identical input.

The second is the tie-break inside non-maximum suppression.
`box_non_max_suppression` sorts by confidence:

```python
# src/supervision/detection/utils/iou_and_nms.py:1005
sort_index = predictions[:, 4].argsort()[::-1]
```

NumPy's default `argsort` kind is quicksort, which is **not stable**. For equal
confidences the surviving detection is therefore decided by input position. And
because tiles overlap by design, the same object detected in two adjacent tiles
with the same score is the *normal* case in a slicer, not an edge case. So the
surviving detection — its exact box, its `class_name`, its `tracker_id`, and any
custom `data` payload — flipped with thread scheduling.

The escalation chain is worth stating on its own, because it is three hops from
"cosmetic" to "wrong answer": unordered collection → positional merge → unstable
sort → a different physical object in the output.

## 2. How I found and reproduced it

I was not sent here by a bug report. The issue I originally set out to fix,
[#781](https://github.com/roboflow/supervision/issues/781), turned out to be
already shipped — batching landed in
[#1239](https://github.com/roboflow/supervision/pull/1239), merged 2026-06-26,
and the issue was simply never closed. So I audited the code that had just landed
there instead, on the theory that a two-month-old merge is where undiscovered
bugs actually live. The docstring and the loop directly below it disagreed.

Both reproducers are pure NumPy — no model, no GPU, no network.

The geometry had to be derived rather than guessed, because two properties of the
slicer will hide the bug from a naive test:

1. The **first slice always runs synchronously**, before the pool is created, so
   the slicer can inspect the callback's output type and detect oriented boxes
   before committing to threads. A reproducer therefore needs at least *two*
   remaining slices for completion order to be able to differ from source order.
2. If the first slice returns no detections, a **probe loop** runs further slices
   sequentially until one comes back non-empty. Slice 0 must return a detection,
   or the whole run serialises and the bug hides.

Each tile is stamped with its own index in the blue channel so the callback can
tell which slice it was handed.

### Row order

1920×640 image, 640 px slices, no overlap → 3 slices. The callback sleeps
`(5 - index) * 0.05s`, so slice 2 finishes first:

```
offsets:
 [[   0    0  640  640]
 [ 640    0 1280  640]
 [1280    0 1920  640]]
run 0: class_id order = [0, 2, 1]   x-offsets = [1.0, 1281.0, 641.0]
run 1: class_id order = [0, 2, 1]   x-offsets = [1.0, 1281.0, 641.0]
run 2: class_id order = [0, 2, 1]   x-offsets = [1.0, 1281.0, 641.0]
```

Source order is `[0, 1, 2]`. Returned order is `[0, 2, 1]`.

### The NMS survivor — the one that matters

1280×640, 640 px slices, 320 px overlap → 3 slices. Slices 1 and 2 both report
the **same absolute box**, same `class_id`, same confidence `0.9`, tagged through
`data["src_slice"]`. Slice 0 reports an unrelated box so the probe loop does not
serialise the run. Slice 1 sleeps 0.2 s; slice 2 returns immediately.

```
before:
thread_workers=1: n=2  surviving src_slice=[0, 2]
thread_workers=4: n=2  surviving src_slice=[0, 1]

after:
thread_workers=1: n=2  surviving src_slice=[0, 2]
thread_workers=4: n=2  surviving src_slice=[0, 2]
```

Same image, same callback, same confidences — a different detection survives NMS
depending only on `thread_workers`.

My first attempt at this reproducer proved nothing: all three detections
survived. `with_nms` is class-aware by default, and I had tagged the three
detections with different `class_id` values, so nothing suppressed anything.
Giving them a shared `class_id` and moving the identifying tag into `data` is
what made the suppression actually engage. The reproducer has to satisfy the
*preconditions of the code path you are accusing*, not just look like the bug.

## 3. What I changed, and what I chose not to

Both threaded collection loops become `Executor.map`:

```python
with ThreadPoolExecutor(max_workers=self.thread_workers) as executor:
    # `Executor.map` yields in submission order, so slices merge in
    # source order no matter which thread finishes first.
    detections_list.extend(
        executor.map(partial(self._run_callback, image), remaining_offsets)
    )
```

`Executor.map` submits every call up front and runs them across the pool exactly
as before. It constrains only the order in which finished results are yielded, so
wall-clock is unchanged: the pool still finishes when the slowest task finishes.
`as_completed` leaves the imports; `functools.partial` enters.

The fix belongs here rather than in NMS because this is where the ordering is
lost. The slicer is the component that knows the source order, and it is the
component that made the promise.

Nothing else moves — the probe loop, the oriented-box sequential guard, the
warning locks, and the batch splitting are untouched.

### Alternatives rejected

**Keep `as_completed` and reorder afterwards.** Collect into a pre-sized list
indexed through a `{future: index}` dict. It works, and it preserves the
fail-on-first-completed-error behaviour. It is six lines instead of three and
needs a `cast` to satisfy mypy about the `None` placeholders. `Executor.map`
states the invariant in the API rather than in bookkeeping a future reader has to
re-derive.

**Fix the docstring instead of the code.** The cheapest possible change, and
wrong. The guarantee was written deliberately in #2256, it costs three lines to
honour, and a detector whose output depends on thread scheduling cannot be
regression-tested by the people using it.

**Make the NMS sort stable with `kind="stable"`.** This fixes the tie-break but
not the row order, leaves the documented contract still false, and changes
behaviour for every caller of NMS rather than for the slicer. It is a real
improvement and I said so in the PR — as a separate change, deliberately out of
scope for this one.

### Left out of scope

The oriented-bounding-box path already runs sequentially, by a guard added in
#2256 precisely because many OBB backends are not thread-safe, so it was never
affected and I did not touch it.

## 4. How I verified it

macOS on Apple Silicon, Python 3.10 through `uv`. `opencv-python` is not
installed locally, so every run exercises supervision's NumPy fallback backend
and prints one `UserWarning` about it.

Three new tests, covering both the per-slice and batched paths, fail on
unmodified `develop` at `0753191a`:

```
FAILED TestInferenceSlicerOrdering::test_threaded_slices_merge_in_source_order[3-slices-4-workers]
  - AssertionError: assert [0, 2, 1] == [0, 1, 2]
FAILED TestInferenceSlicerOrdering::test_threaded_slices_merge_in_source_order[5-slices-8-workers]
  - AssertionError: assert [0, 4, 1, 3, 2] == [0, 1, 2, 3, 4]
FAILED TestInferenceSlicerOrdering::test_threaded_batches_merge_in_source_order
  - AssertionError: assert [0, 1, 4, 5, 2, 3] == [0, 1, 2, 3, 4, 5]
3 failed in 0.07s
```

The shipped tests do not use the sleeps my reproducers used. Sleep-based timing
flakes on a loaded CI runner, and a flaky test that guards a concurrency fix is
worse than no test, because the first spurious failure gets it deleted. They gate
on a `threading.Event` instead: the final slice sets the event, every other
threaded slice waits on it. That makes the reversal deterministic.

Two constraints make the gate safe rather than a deadlock. Slice 0 must never
wait, because it runs synchronously before the pool exists and there would be
nobody left to release it. And the number of simultaneously waiting slices must
never exceed `thread_workers`, or the releasing slice never gets a worker to run
on — hence 3 slices against 4 workers, and 5 against 8.

```
uv run pytest -q                                     # stashed develop:  3633 passed
uv run pytest -q                                     # with the change:  3636 passed
uv run pytest tests/detection/tools/test_inference_slicer.py   #           34 passed
uv run pre-commit run --all-files                    # 21 hooks, all passed (mypy included)
```

The `+3` is exactly the three new tests; no existing test changed state. Both
reproducers were re-run against the fix: row order `[0, 1, 2]` on three
consecutive runs, and an identical NMS survivor at `thread_workers=1` and `4`.

## 5. What transferred

**`as_completed` is a correctness decision, not a style choice.** I had read it
as the idiomatic way to drain a thread pool. It is the idiomatic way to drain a
pool *whose consumer does not care about order*. The moment results are appended
to a list that something later reads positionally, choosing it has changed the
program's output. The grep that finds this class in any codebase is narrow and
worth keeping: find `as_completed`, then look at what happens to the results.

**Composition loses invariants that neither component owns.** `as_completed`
never promised order, so it cannot be blamed for not providing it. `merge` never
promised to sort, so it cannot be blamed either. The invariant lived in the
caller, which is exactly where nobody was checking. When I look for bugs now I
try to ask which properties the seam between two correct components is quietly
responsible for.

**Unstable sorts are where non-determinism becomes visible.** A scrambled input
order is often survivable; it becomes a wrong answer when it meets a sort that
resolves ties by position. `np.argsort` defaults to quicksort and is not stable,
the same is true of C++'s `std::sort`, where `std::stable_sort` is the separate
opt-in. Python's own `sorted` and `list.sort` are stable, which is exactly why the
assumption travels badly. Any ranking step is a place to ask what happens on a tie.

**The interesting bugs are next to the recently-merged code.** The issue I came
for had been fixed two months earlier and nobody had closed it. Reading the code
that closed it — rather than the issue text — is what turned a dead end into a
finding. A stale issue tracker is a signal about where the real work is, not an
obstacle.

**A reproducer must satisfy the preconditions of the path it accuses.** My first
attempt failed because class-aware NMS never compared the detections I had built.
Nothing errored; the test just quietly demonstrated nothing. Before trusting a
reproducer that shows no failure, I now check that the code path I am accusing
actually executed.

---

*AI assistance: the audit, reproducers, fix, tests and verification runs on this
contribution were done with an AI coding assistant working from the project's own
`AGENTS.md`. `roboflow/supervision` has no AI policy restricting this — it ships
`AGENTS.md` and `CLAUDE.md` for coding agents, and has merged bot-authored PRs. I
reviewed every changed line and ran the verification commands above.*

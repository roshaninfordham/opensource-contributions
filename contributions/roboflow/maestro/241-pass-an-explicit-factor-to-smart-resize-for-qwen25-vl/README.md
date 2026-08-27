---
title: Pass an explicit factor to smart_resize for Qwen2.5-VL
project: roboflow/maestro
pr: https://github.com/roboflow/maestro/pull/241
issue: https://github.com/roboflow/maestro/issues/227
opened: 2026-08-27
category: dependency management
skills: [Python, dependency management, NumPy, pytest, multimodal ML]
summary: An unbounded dependency floor let a helper library remove a default argument out from under maestro, breaking every Qwen2.5-VL fine-tuning run on a COCO dataset.
---

# Pass an explicit factor to smart_resize for Qwen2.5-VL

**[roboflow/maestro#241](https://github.com/roboflow/maestro/pull/241)** · +126/-1 across 2 files · fixes [#227](https://github.com/roboflow/maestro/issues/227)

maestro is Roboflow's fine-tuning harness for multimodal models. For Qwen2.5-VL
object detection it converts a dataset's bounding boxes into the JSON string the
model is trained to emit — and crucially into the coordinate space the model will
actually see, not the source image's.

## 1. What was broken

**Bug class: a transitive API change reaching a caller through an unbounded
version floor.**

`detections_to_suffix_formatter` asked `qwen-vl-utils` what resolution the
processor would resize to:

```python
input_h, input_w = smart_resize(height=image_h, width=image_w, min_pixels=min_pixels, max_pixels=max_pixels)
```

`qwen-vl-utils` 0.0.13 made `factor` a required positional argument. maestro's
`pyproject.toml` pins `qwen-vl-utils>=0.0.8` with **no upper bound**, so any fresh
install resolves to a version whose signature that call no longer satisfies:

```
TypeError: smart_resize() missing 1 required positional argument: 'factor'
```

Every COCO detection dataset fails, which is the path the project's own Qwen2.5-VL
cookbook takes.

The interesting part is not the `TypeError` but *why* the argument exists.
Qwen2.5-VL's vision encoder uses a 14px patch with a 2×2 spatial merge, so resized
side lengths must be multiples of 28 or the encoder cannot tile them. `factor` is
that number. Upstream removed its default rather than the argument, on the
reasonable view that a caller should state which model geometry it means.

## 2. How I found and reproduced it

The issue carried no minimal reproducer, so I built one. `smart_resize` pulls in
`torch` and `torchvision` transitively, so a bare install fails on import before
it can fail on signature:

```
qwen-vl-utils version: 0.0.14
signature: (height: int, width: int, factor: int, min_pixels: Optional[int] = None, max_pixels: Optional[int] = None) -> Tuple[int, int]
call WITHOUT factor: TypeError: smart_resize() missing 1 required positional argument: 'factor'
```

Then through maestro's own function, the actual failing path:

```
REPRODUCED TypeError: smart_resize() missing 1 required positional argument: 'factor'
```

**The reporter's suggested fix does not work, and checking is what stopped me
shipping it.** They proposed importing the library's old `IMAGE_FACTOR = 28`
constant. 0.0.13 removed that too:

```python
>>> import qwen_vl_utils.vision_process as vp
>>> [k for k in dir(vp) if k.isupper()]
['FORCE_QWENVL_VIDEO_READER', 'FPS', 'FPS_MAX_FRAMES', 'FPS_MIN_FRAMES', 'FRAME_FACTOR',
 'IMAGE_MAX_TOKEN_NUM', 'IMAGE_MIN_TOKEN_NUM', 'MAX_NUM_WORKERS_FETCH_VIDEO', 'MAX_RATIO',
 'MODEL_SEQ_LEN', 'SPATIAL_MERGE_SIZE', 'VIDEO_MAX_TOKEN_NUM', 'VIDEO_MIN_TOKEN_NUM',
 'VIDEO_READER_BACKENDS']
```

`AttributeError: module 'qwen_vl_utils.vision_process' has no attribute 'IMAGE_FACTOR'`.

I then confirmed 28 from the model side rather than from folklore, by reading
`transformers`' own Qwen image processor: `patch_size` defaults to 14, `merge_size`
to 2, and its vendored `smart_resize` still defaults `factor=28`.

## 3. What I changed, and what I chose not to

Define the constant locally and pass it, exposed as a parameter:

```python
# Qwen2.5-VL's vision encoder uses a 14px patch with a 2x2 spatial merge, so the
# resized side lengths must be multiples of 14 * 2. qwen-vl-utils dropped the default
# for `smart_resize(factor=...)` in 0.0.13; passing it explicitly works on every version.
QWEN_2_5_VL_IMAGE_FACTOR = 28
```

Passing it explicitly is **forward and backward compatible**: the argument exists
in every released version, only its default was removed. So the fix needs no
version bound and cannot break users pinned to an older release.

### Alternatives rejected

**Cap the dependency (`>=0.0.8,<0.0.13`).** The reporter's workaround, and the
tempting one. It freezes users out of upstream fixes to solve a problem one
argument wide, and the repository's convention is unbounded floors — a single cap
would be the odd one out.

**Import the constant from the library.** Impossible, as shown above. This is the
fix I would have shipped had I trusted the issue text.

**Derive `factor` from the loaded processor** (`processor.image_processor.patch_size
* merge_size`). Genuinely more correct; it would track a variant with different
encoder geometry. Rejected here because verifying that attribute chain needs a real
model download, and I was not willing to assert a path I had not executed. The
`image_factor` parameter leaves the door open without claiming it.

### Scope left out

Threading the processor through the call chain. The value is a property of the
model and the repo already hardcodes it everywhere — `min_pixels` and `max_pixels`
default to `256 * 28 * 28` and `1280 * 28 * 28`. That refactor is wider than this
bug earns.

## 4. How I verified it

The module had no test file, so I added one. Expected coordinates were **derived,
not recorded from the implementation** — otherwise a test only proves the code does
what it does. For a 640×480 source, `smart_resize` returns `(h=476, w=644)`, which
is 17×28 and 23×28; a box edge at `y=20` maps to `20 × 476/480 = 19.83`, truncating
to `19`. That is what the test asserts.

Isolating the defect mattered. Reverting the whole file made the new tests fail
with `ImportError` on my own new constant, which proves nothing about the bug.
Reverting *only the call site* makes them fail on the real thing:

```
E       TypeError: smart_resize() missing 1 required positional argument: 'factor'
maestro/trainer/models/qwen_2_5_vl/detection.py:40: TypeError
```

```
pytest test/ --ignore=.../qwen_2_5_vl   27 passed   (baseline)
pytest test/                            33 passed   (+6 new)
ruff check maestro/ test/               All checks passed!
pre-commit run --all-files              11 hooks, all passed (mypy included)
```

## 5. What transferred

**An unbounded version floor is an unbounded API contract.** `>=0.0.8` says "every
future version is fine" about a library you do not control. The cost lands on
users at install time, in a package that worked yesterday.

**Pass an argument whose default encodes something you know.** Relying on
`smart_resize`'s default made maestro's correctness depend on a constant living in
someone else's module. Passing it explicitly is not defensive padding — it moves
the fact to where it is actually known.

**A workaround in an issue is a hypothesis.** The suggested import would have
raised `AttributeError` on the very version that motivated the report. Reporters
test against the version they downgraded *to*, not the one that broke.

**Isolate the defect when proving a regression test.** A test that fails with
`ImportError` on a symbol you just added has demonstrated nothing. Revert the
minimum that reintroduces the actual bug, and check the failure message matches
the report.

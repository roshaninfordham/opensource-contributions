---
title: Validate GGUF tensor dimensions
project: ml-explore/mlx
pr: https://github.com/ml-explore/mlx/pull/4378
issue: https://github.com/ml-explore/mlx/issues/4244
opened: 2026-08-23
category: memory safety
skills: [C++, AddressSanitizer, binary parsing, integer overflow, CMake]
language: C++
summary: Fixed a heap out-of-bounds write in MLX's GGUF model loader, reachable from mx.load() on an untrusted file.
---

# Validate GGUF tensor dimensions

**[ml-explore/mlx#4378](https://github.com/ml-explore/mlx/pull/4378)** · +135/-13 across 3 files · fixes [#4244](https://github.com/ml-explore/mlx/issues/4244)

MLX is Apple's array framework for machine learning on Apple silicon. It reads
GGUF — llama.cpp's model format — which means `mx.load()` turns attacker-controlled
bytes into sizes, offsets, and pointers. A crafted file could make the quantized
loader allocate a 12-byte buffer and then write into it 4.3 billion times.

## 1. What was broken

**Bug class: integer truncation across a representation boundary.**

The element count of a GGUF tensor existed in two widths, derived from the same
file bytes, and nothing ever compared them.

- gguflib computes `tensor.num_weights` as a running `uint64_t` product of the
  file's dimensions. Unsigned overflow wraps silently — that's defined behaviour
  in C, not a crash.
- MLX's `get_shape()` (`mlx/io/gguf.cpp:50`) narrowed each `uint64_t` dimension
  into `ShapeElem`, which is `int32_t`, with no range check:

  ```cpp
  for (int i = tensor.ndim - 1; i >= 0; i--) {
    shape.push_back(tensor.dim[i]);   // uint64 -> int32, unchecked
  }
  ```

- `check_tensor_in_file()` validated `tensor.offset` and `tensor.bsize` against
  the file mapping. That check is correct, and it was the only one. It validates
  the **byte** view. Nothing validated the **element** view.

A second, independent defect made it exploitable. In `gguf_quants.cpp`:

```cpp
std::accumulate(shape.begin(), shape.end(), 1, std::multiplies<size_t>());
//                                          ^ int
```

`std::accumulate` deduces its accumulator type from `init`, not from the binary
operation. `std::multiplies<size_t>` computes a correct 64-bit product which is
then assigned back into an `int` on every iteration. The `std::multiplies<size_t>`
sitting right there is what let this survive review.

Neither defect is dangerous alone. The unchecked narrowing gives a wrong shape,
not a corrupt heap. The `int` accumulator is unreachable, because a shape product
past `INT32_MAX` would need a file too large to exist. Together, the extractor
sizes a buffer from one number and indexes it with the other.

## 2. How I found and reproduced it

The report came with a 1.1 MB proof-of-concept. I wanted one small enough to
commit as a test fixture, which meant solving for it rather than copying it.

Let `a = dim[0]` and `dim[1] = h·2³² + l`, where `l` is the low 32 bits that
survive the narrowing:

```
num_weights = a·(h·2³² + l) = (a·h + q)·2³² + r,   where  a·l = q·2³² + r
```

Four constraints, each a real property of the code:

1. `a·h + q ≡ 0 (mod 2³²)` — cancels the high word, so `num_weights` stays small,
   so `bsize` is small, so the file is small and passes the byte-size check
2. `a·l > 2³⁶` — the scales count must exceed `INT32_MAX` or the allocation size
   never truncates and you get an out-of-bounds *read*, not a *write*
3. `a % 32 == 0` — the loader rejects a last dimension that isn't whole blocks
4. `l ≤ INT32_MAX` — otherwise it narrows negative, a different code path

Solving gives `a = 96`, `l = 1431655766`, `h = 89478485`, so
`dim[1] = 384307168202282326`:

| quantity | value |
|---|---|
| `num_weights` (true product, wrapped) | 64 |
| `bsize` → fixture size | 68 bytes → ~200-byte file |
| narrowed shape | `{1431655766, 96}` |
| scales element count | 4,294,967,298 (past `INT32_MAX`) |
| **allocation actually made** | **12 bytes** |

Built CPU-only with AddressSanitizer, unmodified `main`:

```
==82611==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x6020000008fc
WRITE of size 2 at 0x6020000008fc thread T0
    #0 mlx::core::extract_q8_0_data(...) gguf_quants.cpp:90
    #1 mlx::core::gguf_load_quantized(...) gguf_quants.cpp:145
    #2 mlx::core::load_arrays(gguf_ctx*) gguf.cpp:340
    #3 mlx::core::load_gguf(...) gguf.cpp:367

0x6020000008fc is located 0 bytes after 12-byte region [0x6020000008f0,0x6020000008fc)
```

A 12-byte allocation against a 4,294,967,298-iteration write loop — from a
200-byte file, 16,000× smaller than the original reproducer.

## 3. What I changed, and what I chose not to

The fix restores a single invariant at the single place it broke: **the
shape-derived element count must equal `tensor.num_weights` exactly.**

`get_shape()` now rejects any dimension that doesn't fit in `ShapeElem`, and any
dimension product that overflows 64 bits. With that, every downstream consumer
becomes safe for free — `bsize` derives from `num_weights` and is already
validated against the file, so the extractors' read span provably equals it. No
per-extractor checks needed.

Plus `size_t{1}` in both `accumulate` calls, and an empty-shape guard in
`gguf_load_quantized()` before it indexes the last dimension.

**Alternatives I rejected:**

| Option | Why not |
|---|---|
| Only fix `accumulate` | Insufficient — the now-correct 68 GB allocation fails, `raw_ptr()` returns `nullptr` unchecked, and you get a null-deref crash instead |
| Bounds-check each of the three extractors | Three copies of one check, downstream of where the invariant actually broke |
| Push it upstream to gguflib | `get_shape()` is MLX's own narrowing. gguflib's `num_weights` is honest |
| Compare against `tensor.num_weights` | Both wrap identically — gguflib computes the same product in the same width, so they always match. Detecting the overflow is the only check that distinguishes them |

**What I left out of scope, deliberately:** the reporter also proposed checking
every `allocator::malloc` result. Once dimensions are validated, a huge
allocation requires a genuinely huge file — an out-of-memory condition, not a
reachable attack — and allocator changes reach well past this bug. I said so in
the PR rather than waiting to be asked.

I also did *not* reject `ndim == 0` inside `get_shape()`, because `save_gguf`
writes `num_dim = 0` for scalar arrays; that would have broken the scalar
save/load round-trip. Only the quantized path needs a last dimension.

**Reading the room:** before writing anything I read this maintainer's closed
PRs. He closed one with *"If you read the linked PR you would see why this is not
working"*, redirected another to the upstream library, and closed a third as a
duplicate. The pattern: he rejects redundant checks and fixes placed in the wrong
layer. That shaped the fix as much as the code did.

## 4. How I verified it

```
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DMLX_BUILD_METAL=OFF \
  -DMLX_BUILD_TESTS=ON \
  -DCMAKE_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer -g" \
  -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address"
```

| Check | Result |
|---|---|
| New test on unmodified `main` | ASAN heap-buffer-overflow, trace above |
| Full C++ suite under ASAN | 252/252 cases, 3366/3366 assertions |
| Python load + quantized tests | 51 passed, 3 skipped, 3291 subtests |
| Reporter's four original PoC files | all rejected with a clear error |
| `uvx pre-commit run --all` | clean |

Two things this pass caught that would otherwise have shipped as false claims:

- A stale test count. The branch was rebased mid-work; upstream had added a test,
  so the real Python number was 51, not the 50 I'd recorded earlier.
- A test failure that wasn't one. `test_mxfp8_block_scale_does_not_saturate`
  failed — and the plausible reading was that my change broke it. It was a stale
  binary: the installed library predated the rebase while the test came after it.
  **Before believing a test result, check that the thing you tested is the thing
  you built.**

## 5. What transferred

> When one quantity is represented in two widths or two units, and each is
> validated separately, an attacker's job is to make them disagree.

Here it was elements in `int32` versus bytes in `uint64`. Two earlier PRs had
hardened the byte view carefully and correctly. Nobody ever checked that the
element view agreed with it. **Both checks were individually right — the bug
lived in the gap between them**, which is where this class always lives.

Where to look for the same shape:

- any narrowing cast on a value that came from a file, a socket, or a user
- any size computed twice by different code paths — allocate here, loop there
- `std::accumulate` with a bare `1` or `0` as `init`
- arithmetic performed *before* a bounds check, where it can wrap past it

llama.cpp has three CVEs for this identical pattern in its own GGUF parser. It
isn't an exotic mistake; it's the default outcome of parsing untrusted binary
formats in C++.

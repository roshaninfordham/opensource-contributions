---
title: Use the worker-local GCS client in JobSupervisor
project: ray-project/ray
pr: https://github.com/ray-project/ray/pull/65686
issue: https://github.com/ray-project/ray/issues/65608
opened: 2026-08-23
category: distributed systems
skills: [Python, distributed systems, fault tolerance, pytest, Ray]
summary: A successful Ray job was reported as FAILED after a head-node replacement, because the job supervisor held a GCS client pinned to the dead head's address.
---

# Use the worker-local GCS client in JobSupervisor

**[ray-project/ray#65686](https://github.com/ray-project/ray/pull/65686)** · +43/-8 across 3 files · fixes [#65608](https://github.com/ray-project/ray/issues/65608)

Ray is a distributed compute framework. Submitted jobs are run by a detached
`JobSupervisor` actor on a worker node, which writes the job's terminal status
back to the GCS (Ray's metadata store). With GCS fault tolerance enabled, the
head pod can be replaced mid-job — and when it was, jobs that had *succeeded*
were reported as failed.

## 1. What was broken

**Bug class: a cached endpoint that outlives the thing it points at.**

`JobManager` recorded the head's GCS address at construction and passed it to
every supervisor it spawned, which built its own client from it:

```python
# job_manager.py
self._gcs_address = gcs_client.address
...
.remote(submission_id, entrypoint, metadata or {},
        self._gcs_address, self._cluster_id_hex, self._logs_dir)

# job_supervisor.py
gcs_client = GcsClient(address=gcs_address, cluster_id=cluster_id_hex)
```

When the head pod is replaced, the worker's raylet and CoreWorker reconnect
through the stable head *service*. The supervisor's separately constructed
client does not — it is pinned to an address that no longer answers.

The damage came from the interaction with error handling. The entrypoint exits
`0`; `put_status(SUCCEEDED)` times out against the dead address; the broad
`except Exception` catches that and writes `FAILED` with
`error_type=JOB_ENTRYPOINT_COMMAND_START_ERROR`.

**So a job that ran to completion is reported as having failed to start.** A
failure to *record* an outcome was silently converted into a different outcome.

The correct client was available all along — the same file already reaches for
worker-local state 270 lines below (`ray._private.worker.global_worker.node`).

## 2. How I reproduced it

The reported path needs KubeRay with GCS fault tolerance and a head-pod
replacement. I have neither, so I worked out what the *essential* condition is:

> the address the manager recorded is unusable, while the worker's own client
> still works.

That needs no Kubernetes at all. `_StaleAddressGcsClient` wraps the live client
and reports `127.0.0.1:1` — a reserved port nothing ever binds:

```python
class _StaleAddressGcsClient:
    def __init__(self, client, address):
        self._client = client
        self.address = address
    def __getattr__(self, name):
        return getattr(self._client, name)
```

Submit a job through a `JobManager` built on that, and on master it never
reaches `SUCCEEDED`. With the fix it succeeds in ~9 seconds.

Reducing a Kubernetes-scale failure to a laptop test was the most valuable step
in the whole task — a bug you can only reproduce on infrastructure you don't
have is a bug you can't fix.

## 3. What I changed, and what I chose not to

Use the client already configured for the worker process hosting the actor:

```python
gcs_client = ray._private.worker.global_worker.gcs_client
```

`gcs_address` and `cluster_id_hex` existed *only* to build that client, so both
come out of the supervisor's signature and off the manager side. Net **−4 lines**
of source.

**Alternatives rejected**

| Option | Why not |
|---|---|
| Re-resolve the address when it fails | Still a cached endpoint, just refreshed later. The worker already holds a client that reconnects on its own. |
| Retry `put_status` on timeout | Treats the symptom. With a dead address every retry fails identically. |

**Deliberately out of scope:** the `except Exception` handler that reclassifies a
*persistence* failure as a *startup* error. That is a real second defect, but
transient-error handling in this area is the subject of open PR #65027, and
fixing both here would collide with someone else's work.

**Differentiating from #65027** — required by Ray's contribution policy, and
worth doing regardless: #65027 patches the *monitor loop* to retry transient gRPC
errors. This patches *client construction*. They are complementary, and #65027's
retries cannot rescue a client pinned to an address nothing is listening on.

## 4. How I verified it

| Check | Result |
|---|---|
| New test on unmodified master | **fails** |
| New test with the fix | passes, 9.17s |
| Supervisor / submission / logging / failover tests | 7 passed, 63 deselected, 82.54s |
| `pre-commit` with Ray's own config | ruff, pydoclint, black, docstyle, semgrep, import order — all passed |
| Rebased onto current `upstream/master` | 0 behind, re-verified after |

Two measurement problems worth recording, because both would have produced a
false statement in the PR:

**A linter run with the wrong config.** Bare `ruff` reported 59 errors on the
touched files — deprecated `typing.Dict`, blind `except Exception`. All
pre-existing Ray style debt; none from my four lines. Ray's `pyproject.toml`
selects a narrower rule set through pre-commit, which passes clean. *Running a
tool with default configuration against a project that configures it tells you
about the defaults, not the project.*

**A test run that was hung, not slow.** The full module suite sat for 50 minutes.
Rather than wait or report it as passing, I checked whether it was doing
anything: pytest at 0.0% CPU, zero Ray processes alive, last Ray session created
47 minutes earlier. It had stalled almost immediately, with and without my
change. I killed it, ran a targeted subset that completes in 82 seconds, and said
exactly that in the PR rather than claiming a full-suite pass.

## 5. What transferred

> A cached endpoint is a bet that the thing it points at will outlive the cache.

Every failover story has this shape: something records an address, a handle, a
leader, a shard owner — and keeps using it after the world has moved. The fix is
almost never a better refresh; it is to *stop caching* and use the handle that
already knows how to reconnect. The reconnecting client existed in the same
process the whole time.

The second, nastier half generalizes further:

> Failing to record an outcome is not the same as a different outcome.

The `except Exception` here turned "I could not write down that this succeeded"
into "this failed to start." Any code where the persistence of a result shares an
error path with the production of that result can invert its own answer. Worth
looking for wherever a status write sits inside the same `try` as the work.

And operationally: **check whether a slow thing is progressing before you wait on
it.** Fifty minutes of a hung process looks exactly like fifty minutes of a slow
one, until you look at CPU.

---
title: fix(mcp): stop interpolating notification text into AppleScript/PowerShell
project: google/artemis
pr: https://github.com/google/artemis/pull/149
issue: https://github.com/google/artemis/issues/139
opened: 2026-09-22
category: security
skills: [Python, subprocess, AppleScript, PowerShell, shell injection]
language: Python
summary: Desktop toast notifications built AppleScript/PowerShell source by f-string interpolation, so a quote or newline in agent-generated text ran as its own statement; fixed by passing text through the environment instead of the script source.
---

# fix(mcp): stop interpolating notification text into AppleScript/PowerShell

**[google/artemis#149](https://github.com/google/artemis/pull/149)** · +98/-8 across 2 files

Artemis is an MCP server that drives Android devices for AI coding agents (Claude
Code, Cursor, etc.) — it lets an agent read a phone's screen and act on it. After
every task it fires a desktop toast notification via `osascript` (macOS) or
`powershell` (Windows), on by default, with no opt-in required.

## 1. What was broken

`DesktopNotifier.notify()` in `mcp_server/notifiers/desktop.py` built the
notification command by f-string interpolating the title and body straight into
the AppleScript/PowerShell *source text*:

```python
script = f'display notification "{clean_body}" with title "{header}"'
subprocess.run(["osascript", "-e", script], ...)
```

This is a code-injection bug, not a shell-injection one — `subprocess.run` is
called with a list (`shell=False`), so there's no POSIX shell to escape for.
The vulnerable interpreter is AppleScript/PowerShell itself: a `"` in `clean_body`
closes the string literal early, and whatever follows runs as a new AppleScript
statement, including `do shell script "..."`, which does get an OS shell.

The invariant that's supposed to hold — "the text a user or an agent supplies is
data, never code" — was violated at the boundary where that text got spliced into
source rather than passed as a value. `clean_body` and `header` aren't operator
input either: they come from the task goal and the agent's own result/explanation,
which can include text the agent read directly off the screen of the app it's
automating. So the injection is reachable indirectly, through content on a page
or in an app, not just by a user typing a malicious goal.

## 2. How I found and reproduced it

I was scanning `google/artemis`'s open issues for the highest-impact one to work
first (my workspace does one fix at a time). Issue #139 had a clear write-up and
PoC from its reporter, `carfeii`, plus a stated intent to fix it: "I have a fix
and will open a PR." Two related shell-injection issues (#55, #99) already had
three to four competing duplicate PRs each, so this looked like the most severe
still-open gap (on by default, host-level RCE, not sandboxed to the Android
device like #55).

I initially read it as unclaimed because there was no open PR against it — that
was wrong. `carfeii` had already opened #140 with essentially this exact fix and
self-closed it about ten hours later, right around when its CLA check first
failed (the same check I hit and needed Roshan to clear by signing). I only
found this after landing my own PR, by checking the issue author's PR history —
something I should have done before writing the fix, not after. #149's PR
description and title now credit #140 and offer to close in its favor if
`carfeii` wants to finish their own PR instead.

I didn't just trust the write-up. This machine is actually macOS, so I reproduced
the exploit against the *live, unpatched* code with `osascript` for real:

```python
clean_body = 'pwned" \ndo shell script "touch /tmp/artemis_pwned_e2e"\n--'
script = f'display notification "{clean_body}" with title "Artemis Task Completed"'
subprocess.run(["osascript", "-e", script], ...)
```

```
$ ls -la /tmp/artemis_pwned_e2e
-rw-r--r--@ 1 rs  wheel  0 Sep 22 15:08 /tmp/artemis_pwned_e2e
```

The file was created — real command execution, not a hypothetical.

## 3. What I changed, and what I chose not to

The design here is `carfeii`'s, laid out in #139 and already implemented in
#140: keep the AppleScript/PowerShell source a fixed constant and pass the
title/body through the subprocess environment instead, reading them back
inside the now-static script with `system attribute` (AppleScript) and `$env:`
(PowerShell). #149 uses the same approach, arrived at independently before I
found #140 (variable names differ; the mechanism is identical):

```python
script = (
    'display notification (system attribute "ARTEMIS_NOTIFY_BODY") '
    'with title (system attribute "ARTEMIS_NOTIFY_TITLE")'
)
subprocess.run(
    ["osascript", "-e", script],
    env={**os.environ, "ARTEMIS_NOTIFY_TITLE": header, "ARTEMIS_NOTIFY_BODY": clean_body},
    ...
)
```

Since the script text never varies with the input, there's no quoting/escaping
question left — the value can be anything, including more quotes and newlines,
and it's still just a string held in an env var, never parsed as AppleScript or
PowerShell. What I did contribute independently: getting a signed CLA in place
(the thing that apparently stalled #140), verifying the fix against real
`osascript` rather than trusting the design on paper, and the regression tests.

**Alternative in the codebase already:** a separate open PR (#58, predates this
issue) takes an escaping route instead — helper functions that backslash-escape
`"`/`\` for AppleScript and backtick-escape `` ` ``/`"`/`$` for PowerShell. That
works for the exact characters it lists, but it's a blacklist: it has to
enumerate every metacharacter each interpreter's string-literal syntax cares
about and stay correct as that list changes. The env-var approach removes the
category of bug instead of enumerating members of it, for about the same diff
size. I noted this trade-off on the PR for maintainers to choose between; I
didn't unilaterally decide #58 is wrong.

**Left out of scope:** the Linux `notify-send` branch already passes `header`/
`clean_body` as separate argv elements with `shell=False` — there's no
interpolation there, so nothing to fix. I also didn't touch `ScriptNotifier`
(#99) or the ADB driver (#55) — both already have multiple competing community
PRs open, and mixing an unrelated fix into this PR would make it harder to
review and revert independently.

## 4. How I verified it

Verification I did before an outside review flagged gaps in it, plus what I
added after:

- Reproduced the injection against the *unpatched* code with real `osascript`
  on this machine (it's actually macOS): a crafted body created a file on disk,
  confirming the vuln is real, not just plausible from reading the source.
- Re-ran the same PoC through the *patched* `DesktopNotifier.notify()` (the real
  module): no file created.
- Confirmed legitimate behavior isn't collateral damage: a body containing a
  literal `"` comes through unmangled via the env var.
- Added two regression tests to `tests/unit/mcp/test_notifiers.py` (macOS and
  Windows branches).

An outside review of this write-up (before publishing) pointed out three gaps
in that list, which I then closed:

- **"No file created" alone doesn't prove the script executed** — `notify()`
  swallows stdout/stderr and returns `True` even if `osascript` fails on a
  syntax error. Fixed by capturing real exit codes: fed 9 hostile payloads
  (quotes, backslashes, `$()`, backticks, CRLF, a Unicode line separator, a
  5000-char string) through the patched code and confirmed `returncode == 0`
  with empty stderr every time — the fix doesn't just fail to inject, it
  actually delivers the notification.
- **No proof the new tests fail without the fix** — my original "88 identical
  failures on `main` vs. this branch" comparison was contaminated: checking out
  `main`'s files also reverted the test file, so the 2 new tests were *absent*
  from that run, not *failing*. Fixed by running the actual assertion
  (`payload not in script`) against both `desktop.py` versions directly: it
  fails against unpatched `main` (the payload lands verbatim in the script
  text) and passes against the patched version.
- **No proof of fidelity, only non-exploitation** — round-tripped a payload
  containing mixed quotes/backslashes/`$`/backticks/embedded newlines through
  the env var and read it back via AppleScript's `system attribute`: exact
  byte-for-byte match, so the fix doesn't trade an injection bug for a
  data-corruption one.

Also:
- `uv run pytest` (the full deterministic suite `make test` runs) on `main` and
  on this branch, with the test file intact on both sides this time: same 88
  pre-existing, unrelated failures (missing `adb`, missing model credentials,
  Windows-only tests, stale local DB state — matches already-filed issues
  #18/#62/#97/#95) on both, my branch adds exactly the 2 new tests passing.
- `uv run ruff format --check`, `uv run ruff check`, `uv run python
  scripts/quality_ratchet.py`, `uv run pyright --project pyright-core.json` all
  clean on the changed files.
- **What's still not verified:** the Windows branch. `$env:VAR` is standard
  PowerShell and low-risk, but I only mock-tested it (asserting the script
  text's shape) — I never ran it against a real `powershell.exe`, because this
  machine can't. Said so plainly on the PR rather than implying Windows parity
  with the macOS testing.

## 5. What transferred

Two lessons, one technical and one procedural.

Technical: `shell=True` isn't the only way to get command injection from
`subprocess` — `shell=False` with a list of args is safe against a POSIX shell,
but if one of those args is itself source code for a *different* interpreter
(AppleScript, PowerShell, SQL, a template engine), the injection surface just
moved one layer in. The fix pattern that generalizes: don't try to out-escape an
embedded interpreter's string-literal grammar with a growing blacklist. If the
interpreter has any channel for reading a value that isn't source text — an
environment variable, a bind parameter, a side-channel file — route untrusted
data through that instead, so the source stays a compile-time constant.

Procedural: "no open PR" is not the same as "unclaimed." Before writing a fix
for someone else's filed issue, check that reporter's own PR history, not just
the issue thread and the repo's open-PR list — a closed PR from the reporter
carries the design and the credit even if it never merged. I did this check
after landing the fix instead of before, caught it because I asked an outside
reviewer to verify the work rather than just re-asserting my own summary of it,
and corrected the PR and this write-up once I saw it. The generalizable habit:
when a task says "verify this is correct" or "guarantee this is right," treat
that as a request for an adversarial second pass, not a request to restate
confidence in the first pass.

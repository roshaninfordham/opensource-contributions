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
first (my workspace does one fix at a time). Issue #139 already had a clear
write-up and a PoC from another reporter, but no PR — the reporter said Google's
OSS VRP triage declined to pay out (project below their reward tier) and told them
to open a PR directly, which they hadn't yet done. Two related shell-injection
issues (#55, #99) already had three to four competing duplicate PRs each, so I
picked the one that was both most severe (on by default, host-level RCE, not
sandboxed to the Android device like #55) and still unclaimed.

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

I kept the AppleScript/PowerShell source a fixed constant and passed the title
and body through the subprocess environment instead, reading them back inside
the (now-static) script with `system attribute` (AppleScript) and `$env:`
(PowerShell):

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
PowerShell.

**Alternative I rejected:** an existing open PR (#58, predates this issue) takes
the escaping route — helper functions that backslash-escape `"`/`\` for
AppleScript and backtick-escape `` ` ``/`"`/`$` for PowerShell. That works for the
exact characters it lists, but it's a blacklist: it has to enumerate every
metacharacter each interpreter's string-literal syntax cares about and stay
correct as that list changes. The env-var approach removes the category of bug
instead of enumerating members of it, for about the same diff size.

**Left out of scope:** the Linux `notify-send` branch already passes `header`/
`clean_body` as separate argv elements with `shell=False` — there's no
interpolation there, so nothing to fix. I also didn't touch `ScriptNotifier`
(#99) or the ADB driver (#55) — both already have multiple competing community
PRs open, and mixing an unrelated fix into this PR would make it harder to
review and revert independently.

## 4. How I verified it

- Re-ran the exact PoC through the *patched* `DesktopNotifier.notify()` (the real
  module, not a reimplementation): `notify()` still returns `True`, and no file
  was created — the injected `do shell script` never executes.
- Confirmed legitimate behavior isn't collateral damage: a body containing a
  literal `"` (`He said "hello" and it worked`) comes through unmangled via the
  env var, so normal notification text isn't garbled the way a naive escaping
  scheme could garble it.
- Added two regression tests to `tests/unit/mcp/test_notifiers.py` (macOS and
  Windows branches) that patch `sys.platform` and `subprocess.run`, feed in the
  injection payload, and assert it never appears inside the constructed script
  text and reaches the subprocess only via `env`.
- `uv run pytest` (the full deterministic suite `make test` runs) on `main` and
  on this branch: identical 88 pre-existing, unrelated failures on both (missing
  `adb`, missing model credentials, Windows-only tests, stale local DB state —
  matches already-filed issues #18/#62/#97/#95). My branch adds exactly the 2 new
  tests, passing, and breaks nothing that wasn't already broken.
- `uv run ruff format --check`, `uv run ruff check`, `uv run python
  scripts/quality_ratchet.py`, `uv run pyright --project pyright-core.json` all
  clean on the changed files.

## 5. What transferred

`shell=True` isn't the only way to get command injection from `subprocess` —
`shell=False` with a list of args is safe against a POSIX shell, but if one of
those args is itself source code for a *different* interpreter (AppleScript,
PowerShell, SQL, a template engine), the injection surface just moved one layer
in. The fix pattern that generalizes: don't try to out-escape an embedded
interpreter's string-literal grammar with a growing blacklist. If the interpreter
has any channel for reading a value that isn't source text — an environment
variable, a bind parameter, a side-channel file — route untrusted data through
that instead, so the source stays a compile-time constant and the "is this fully
escaped" question stops being answerable-but-fragile and becomes structurally
moot.

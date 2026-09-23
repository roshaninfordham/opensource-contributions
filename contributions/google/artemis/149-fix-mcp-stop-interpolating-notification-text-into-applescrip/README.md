---
title: fix(mcp): stop interpolating notification text into AppleScript/PowerShell
project: google/artemis
pr: https://github.com/google/artemis/pull/149
issue: https://github.com/google/artemis/issues/139
opened: 2026-09-22
category: security
skills: [Python, subprocess, AppleScript, PowerShell, text encoding]
language: Python
summary: Desktop toast notifications built AppleScript/PowerShell source by interpolation, so a quote or newline in the input ran as its own statement; fixed by passing text as argv/env values instead of splicing it into the script source.
---

# fix(mcp): stop interpolating notification text into AppleScript/PowerShell

**[google/artemis#149](https://github.com/google/artemis/pull/149)** · +142/-9 across 2 files, 2 commits

Artemis is an MCP server that drives Android devices for AI coding agents (Claude
Code, Cursor, etc.). After every task it fires a desktop toast notification via
`osascript` (macOS) or `powershell` (Windows), on by default.

## 1. What was broken

`DesktopNotifier.notify()` in `mcp_server/notifiers/desktop.py` built the
notification command by interpolating the title and body straight into the
AppleScript/PowerShell *source text*:

```python
script = f'display notification "{clean_body}" with title "{header}"'
subprocess.run(["osascript", "-e", script], ...)
```

This is a code-injection bug, not a shell-injection one — `subprocess.run` is
called with a list (`shell=False`), so there's no POSIX shell to escape for.
The vulnerable interpreter is AppleScript/PowerShell itself: a `"` in `clean_body`
closes the string literal early, and whatever follows runs as a new AppleScript
statement, including `do shell script "..."`, which does get an OS shell.

**Severity, checked against the actual call sites, not assumed from the issue
report:** issue #139 characterized this as reachable through content an agent
reads off an app's screen mid-task, with no separate victim action. I checked
every current caller of `notify()` in the repo (`task_runner.py`,
`task_manager.py` — six call sites). Each builds `message` as a fixed literal
sentence followed by `"\n\n"`, with the attacker-influenced task goal/result
text only appearing after that. Since `clean_body =
message.split("\n\n")[0][:120]`, `clean_body` is always exactly that fixed
sentence — the attacker content never survives the split. `title` is likewise
always a fixed literal per call site. So `DesktopNotifier.notify()` is unsafe
against attacker input at the function level — any caller passing raw text
directly is exploitable, which is what every PoC here (including mine) does —
but none of the current call sites route attacker content into it. This is
real hardening (closes the gap for a future caller or a refactor of these call
sites), not a bug actively reachable through today's normal task flow. I said
this plainly on the PR rather than repeating the stronger claim unverified.

## 2. How I found and reproduced it

I was scanning `google/artemis`'s open issues for the highest-impact one to
work first (my workspace does one fix at a time). Issue #139 had a clear
write-up and PoC from its reporter, `carfeii`, plus a stated intent to fix it:
"I have a fix and will open a PR." Two related shell-injection issues (#55,
#99) already had three to four competing duplicate PRs each, so this looked
like the most severe still-open gap.

I initially read #139 as unclaimed because there was no open PR against it —
that was wrong. `carfeii` had already opened #140 with essentially this exact
fix and closed it themselves about ten hours later; I don't know why (I
initially guessed it was the CLA check, but the timing doesn't clearly support
that, and I shouldn't have guessed at another contributor's reasons in public
text — corrected on the PR). I only found #140 after landing my own PR, by
checking the issue author's PR history — something I should have done before
writing the fix, not after. #149 now credits #140 explicitly and offers to
close in its favor if `carfeii` wants to finish their own PR instead.

I didn't just trust the write-up. This machine is actually macOS, so I
reproduced the exploit against the *live, unpatched* code with `osascript` for
real:

```python
clean_body = 'pwned" \ndo shell script "touch /tmp/artemis_pwned_e2e"\n--'
script = f'display notification "{clean_body}" with title "Artemis Task Completed"'
subprocess.run(["osascript", "-e", script], ...)
```

```
$ ls -la /tmp/artemis_pwned_e2e
-rw-r--r--@ 1 rs  wheel  0 Sep 22 15:08 /tmp/artemis_pwned_e2e
```

The file was created — real command execution at the function level.

## 3. What I changed, and what I chose not to

The design is `carfeii`'s, laid out in #139 and already implemented in #140:
keep the AppleScript/PowerShell source a fixed constant and pass title/body as
values rather than splicing them into the source. My first commit followed
that design closely — env vars read back via AppleScript's `system attribute`
and PowerShell's `$env:`.

That first version had a real bug I introduced and then caught myself, before
merge: `system attribute` re-decodes its value through the wrong text
encoding, corrupting non-ASCII input. The default notification title is
literally `"☕ Artemis Task {event_type}"` — every default notification would
have shipped garbled:

```
>>> subprocess.run(["osascript","-e",'return (system attribute "X")'],
...     env={**os.environ,"X":"☕ Artemis Task Completed"}, capture_output=True, text=True).stdout
'‚òï Artemis Task Completed'
```

Second commit: switched the macOS branch to pass title/body as `on run argv`
arguments after a `--` separator, instead of environment variables read back
via `system attribute`. Argv values pass through as literal UTF-8, so this
keeps the same injection-proof property (script text still never varies with
input) while fixing the encoding corruption. `--` also stops a title/body that
happens to equal an osascript flag (`-e`, `--`) from being misparsed — another
edge case the `system attribute` version didn't have but that argv parsing
introduces if unguarded. Windows keeps the `$env:` approach: Windows
environment variables are natively UTF-16 and PowerShell doesn't re-decode
them the way `system attribute` does, so that branch never had the encoding
bug.

```python
script = (
    "on run argv\n"
    "    display notification (item 2 of argv) with title (item 1 of argv)\n"
    "end run"
)
subprocess.run(["osascript", "-e", script, "--", header, clean_body], ...)
```

**Alternative in the codebase already:** a separate open PR (#58, predates
this issue) takes an escaping route instead — helper functions that
backslash-escape `"`/`\` for AppleScript and backtick-escape `` ` ``/`"`/`$`
for PowerShell. That works for the exact characters it lists, but it's a
blacklist: it has to enumerate every metacharacter each interpreter's
string-literal syntax cares about and stay correct as that list changes.
Passing values out-of-band (argv/env) removes the category of bug instead of
enumerating members of it. I noted this trade-off on the PR for maintainers to
choose between rather than unilaterally deciding #58 is wrong.

**Left out of scope:** the Linux `notify-send` branch already passes
`header`/`clean_body` as separate argv elements with `shell=False` — no
interpolation there. I also didn't touch `ScriptNotifier` (#99) or the ADB
driver (#55) — both already have multiple competing community PRs open, and
mixing an unrelated fix into this PR would make it harder to review and
revert independently.

## 4. How I verified it

What I checked before asking for a second review pass, then what that pass
caught and I closed:

- Reproduced the injection against the unpatched code with real `osascript`
  on this machine, and re-ran the same PoC through the patched module: file
  created on `main`, no file created after the fix.
- Confirmed a body containing a literal `"` comes through unmangled.
- Added regression tests to `tests/unit/mcp/test_notifiers.py`.

Gaps a second pass found, closed before publishing this write-up:

- **"No file created" doesn't prove the script executed** — `notify()`
  swallows stdout/stderr and returns `True` even on an `osascript` syntax
  error. Fixed by capturing real exit codes: fed 14 payloads (injection
  attempts, `-e`/`--` edge-case values, non-ASCII/emoji text) through the
  patched code and confirmed `returncode == 0` with empty stderr for every
  one — the fix delivers the notification, it doesn't just fail safely.
- **The non-ASCII corruption bug itself** — caught by a round-trip fidelity
  check the second pass asked for specifically (not just an injection check):
  round-tripping the default emoji title and mixed Latin/CJK text through
  `system attribute` came back mangled. That's what triggered the argv
  rewrite in section 3.
- **No proof the new tests fail without the fix** — an earlier comparison
  ("88 identical failures on `main` vs. this branch") was contaminated:
  checking out `main`'s files also reverted the test file, so the new tests
  were *absent* from that run, not *failing*. Fixed by running each new
  test's assertion against both `desktop.py` versions directly: fails on
  unpatched `main`, passes on the fix.
- **The severity claim in section 1** — copied from the issue without
  independently checking the call sites; corrected after actually reading
  `task_runner.py`.

Also:
- `uv run pytest` (full suite) on `main` and on this branch: same 88
  pre-existing, unrelated failures on both (missing `adb`, missing model
  credentials, Windows-only tests, stale local DB state — matches
  already-filed issues #18/#62/#97/#95); this branch adds 3 new passing tests.
- `uv run ruff format --check`, `uv run ruff check`, `uv run python
  scripts/quality_ratchet.py`, `uv run pyright --project pyright-core.json`
  all clean on the changed files.
- **Still not verified:** the Windows branch. `$env:VAR` is standard
  PowerShell and low-risk, but only mock-tested (asserting the script text's
  shape) — never run against real `powershell.exe`, because this machine
  can't.

## 5. What transferred

Three lessons.

Technical, encoding: passing untrusted text out-of-band (argv, env vars) to
avoid injection only works if the out-of-band channel round-trips the value
faithfully. `system attribute` looked like the more "principled" fix over
argv — no positional-argument parsing edge cases — but it silently re-encodes
its value, which is worse than an injection bug in one way: it fails on every
input containing non-ASCII text, not just adversarial ones, so a naive
happy-path test (ASCII-only PoC, ASCII-only fidelity check) won't catch it.
Test the channel with the input the *feature* actually needs to carry (here:
an emoji in the default title), not only the input an *attacker* would send.

Technical, injection: `shell=True` isn't the only way to get command
injection from `subprocess` — `shell=False` with a list of args is safe
against a POSIX shell, but if one of those args is itself source code for a
different interpreter, the injection surface moved one layer in, not away.

Procedural: "no open PR" is not "unclaimed" — check the reporter's own PR
history before writing a fix for their issue. And a request to "verify" or
"guarantee" correctness is a request for an adversarial second pass, not a
request to restate confidence in the first pass — it found a real encoding
bug, a real overclaimed severity, and several inaccurate claims about my own
verification steps, none of which showed up from me re-reading my own work.

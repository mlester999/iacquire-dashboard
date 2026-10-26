"""Report files modified (not added) whose line endings flipped, e.g. CRLF -> LF, and optionally repair them.

usage (run from the worktree root):
  python -I eol_scan.py <base> <head> [--fix]       compare two commits
  python -I eol_scan.py <base> WORKTREE [--fix]     compare a commit with the files on disk (uncommitted edits included)
--fix rewrites each flipped file on disk to the base file's ending (LF -> CRLF or CRLF -> LF). Only meaningful with WORKTREE as the head.
"""
import subprocess
import sys

base, head = sys.argv[1], sys.argv[2]
fix = "--fix" in sys.argv
worktree = head == "WORKTREE"


def git(*args):
    return subprocess.run(["git", *args], capture_output=True).stdout


def counts(data):
    crlf = data.count(b"\r\n")
    return crlf, data.count(b"\n") - crlf


if worktree:
    names = git("diff", "--name-only", "--diff-filter=M", base).decode().split("\n")
else:
    names = git("diff", "--name-only", "--diff-filter=M", base, head).decode().split("\n")
flipped = []
for name in filter(None, names):
    old = git("show", f"{base}:{name}")
    if worktree:
        try:
            with open(name, "rb") as fh:
                new = fh.read()
        except FileNotFoundError:
            continue
    else:
        new = git("show", f"{head}:{name}")
    oc, ol = counts(old)
    nc, nl = counts(new)
    old_kind = "CRLF" if oc > ol else "LF"
    new_kind = "CRLF" if nc > nl else ("LF" if nl else old_kind)
    mixed = bool(nc and nl)
    if old_kind != new_kind or mixed:
        flipped.append((name, old_kind, new_kind, mixed))
for name, a, b, mixed in flipped:
    print(f"{name}: {a} -> {b}{' (mixed)' if mixed else ''}")
print(f"{len(flipped)} file(s) with changed line endings")

if fix:
    if not worktree:
        print("--fix needs WORKTREE as the head")
        sys.exit(2)
    for name, old_kind, new_kind, mixed in flipped:
        with open(name, "rb") as fh:
            data = fh.read()
        data = data.replace(b"\r\n", b"\n")
        if old_kind == "CRLF":
            data = data.replace(b"\n", b"\r\n")
        with open(name, "wb") as fh:
            fh.write(data)
        print("fixed", name)

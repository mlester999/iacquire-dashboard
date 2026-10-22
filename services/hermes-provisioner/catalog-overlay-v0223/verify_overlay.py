"""Verify the exact Hermes v0.22.3 sources and iAcquire catalog overlay before image build."""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _verify_manifest(root: Path, manifest: Path) -> None:
    root = root.resolve(strict=True)
    manifest = manifest.resolve(strict=True)
    for raw in manifest.read_text(encoding="ascii").splitlines():
        line = raw.strip()
        if not line:
            continue
        fields = line.split(None, 1)
        if len(fields) != 2 or not _SHA256.fullmatch(fields[0]):
            raise SystemExit(f"Invalid checksum manifest: {manifest.name}")
        relative = Path(fields[1].strip().replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(f"Unsafe path in checksum manifest: {manifest.name}")
        candidate = root / relative
        if candidate.is_symlink():
            raise SystemExit(f"Unsafe checksum target: {relative.as_posix()}")
        target = candidate.resolve(strict=True)
        if root not in target.parents or not target.is_file():
            raise SystemExit(f"Unsafe checksum target: {relative.as_posix()}")
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        if actual != fields[0]:
            raise SystemExit(f"Checksum mismatch: {relative.as_posix()}")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        raise SystemExit("usage: verify_overlay.py HERMES_ROOT OVERLAY_ROOT")
    hermes_root, overlay_root = map(Path, argv[1:])
    _verify_manifest(hermes_root, overlay_root / "UPSTREAM_SHA256SUMS")
    _verify_manifest(overlay_root, overlay_root / "SHA256SUMS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

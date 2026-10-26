"""Build a source-only ZIP from tracked files, or the bundled source manifest.

Run from any directory: python scripts/package_source.py --out ../alfa-news-agent-clean.zip
Stage new source files first. Dependencies, builds, local data and Git history are omitted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "config/source-manifest.json"
EXCLUDED_PARTS = {".git", "node_modules", "dist", ".venv", "__pycache__", ".pytest_cache", "var"}
OLD_DIRECTORIES = {"alfa-news-agent", "project", "delivery-task2", "verification", "evidence"}
OLD_FILES = {"changes.patch", "MANIFEST.json", "SHA256SUMS.txt", "README_FIXED.md"}


def source_files() -> list[Path]:
    tracked = True
    try:
        top = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"],
                                      stderr=subprocess.DEVNULL, text=True).strip()
        if Path(top).resolve() != ROOT:
            raise ValueError("The containing Git repository is not this project")
        names = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"]).decode().split("\0")
    except (OSError, subprocess.CalledProcessError, ValueError):
        tracked = False
        names = list(json.loads((ROOT / MANIFEST).read_text(encoding="utf-8")))
    result = []
    for name in sorted(set(names)):
        if not name or name == MANIFEST:
            continue
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            raise ValueError(f"Invalid source path: {name}")
        file = ROOT / name
        if not file.exists():
            if not tracked:
                raise ValueError(f"Missing bundled source: {name}")
            continue  # A tracked deletion in the current working tree.
        if path.parts[0] in OLD_DIRECTORIES or name in OLD_FILES or name.startswith("docs/archive/"):
            raise ValueError(f"Remove the obsolete delivery copy before packaging: {name}")
        if (any(part in EXCLUDED_PARTS for part in path.parts) or file.suffix in {".zip", ".pyc", ".log"}
                or any(part.startswith(".env") and not part.endswith(".example") for part in path.parts)):
            continue
        if file.is_symlink() or not file.resolve().is_relative_to(ROOT):
            raise ValueError(f"Source must be an ordinary project file: {name}")
        if file.is_file():
            result.append(file)
    if ROOT / "package.json" not in result or ROOT / "server/integration/live-store.ts" not in result:
        raise ValueError("Incomplete project source")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="ZIP outside the project directory")
    parser.add_argument("--check", action="store_true", help="Only verify the existing source manifest")
    args = parser.parse_args()
    if args.check and args.out:
        parser.error("Use --check or --out")
    output = (args.out or ROOT.parent / "alfa-news-agent-clean.zip").resolve()
    if output.is_relative_to(ROOT):
        parser.error("Keep the ZIP outside the source project")
    files = source_files()
    manifest = {str(file.relative_to(ROOT)): {"sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                                           "bytes": file.stat().st_size} for file in files}
    target = ROOT / MANIFEST
    if args.check:
        if json.loads(target.read_text(encoding="utf-8")) != manifest:
            raise ValueError("Source manifest differs from the working tree; rebuild the source ZIP")
        print(f"Source manifest verified: {len(files)} files")
        return 0
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in [*files, target]:
            entry = zipfile.ZipInfo("alfa-news-agent/" + file.relative_to(ROOT).as_posix())
            entry.external_attr = (file.stat().st_mode & 0xFFFF) << 16
            archive.writestr(entry, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    print(f"{output}: {len(files)+1} files, {output.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

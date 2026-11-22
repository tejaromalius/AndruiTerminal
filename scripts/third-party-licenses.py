#!/usr/bin/env python3
"""Write license notices for third-party code shipped in the .deb.

Covers Rust crates linked into andrui-terminal (normal dependencies for the host
target) and npm packages bundled into the frontend (production dependencies).
Usage: third-party-licenses.py OUTPUT_FILE
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LICENSE_PREFIXES = ("license", "licence", "copying", "notice", "unlicense")


def license_texts(directory):
    files = sorted(
        p for p in directory.iterdir()
        if p.is_file() and p.name.lower().startswith(LICENSE_PREFIXES)
    )
    return [(p.name, p.read_text(errors="replace").strip()) for p in files]


def rust_packages():
    host = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True).stdout
    triple = next(line.split(": ", 1)[1] for line in host.splitlines() if line.startswith("host: "))
    meta = json.loads(subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", triple],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout)
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = next(p["id"] for p in meta["packages"] if p["name"] == "andrui-terminal" and p["source"] is None)

    seen, stack = set(), [root]
    while stack:
        for dep in nodes[stack.pop()]["deps"]:
            if any(k["kind"] is None for k in dep["dep_kinds"]) and dep["pkg"] not in seen:
                seen.add(dep["pkg"])
                stack.append(dep["pkg"])

    for pid in seen:
        p = packages[pid]
        if p["source"] is None:  # workspace crates are AndruiTerminal itself
            continue
        yield (p["name"], p["version"], p.get("license") or "UNKNOWN",
               p.get("repository") or "", Path(p["manifest_path"]).parent)


def npm_packages():
    frontend = ROOT / "web"
    top = json.loads((frontend / "package.json").read_text())

    def resolve(name, from_dir):
        # Node resolution: nearest node_modules walking up to web/.
        d = from_dir
        while True:
            candidate = d / "node_modules" / name
            if (candidate / "package.json").is_file():
                return candidate
            if d == frontend:
                return None
            d = d.parent

    seen, stack, out = set(), [(n, frontend) for n in top.get("dependencies", {})], []
    while stack:
        name, base = stack.pop()
        pkg_dir = resolve(name, base)
        if pkg_dir is None:
            continue  # optional/uninstalled dependency
        key = pkg_dir.resolve()
        if key in seen:
            continue
        seen.add(key)
        pj = json.loads((pkg_dir / "package.json").read_text())
        lic = pj.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type")
        repo = pj.get("repository")
        if isinstance(repo, dict):
            repo = repo.get("url")
        out.append((pj["name"], pj.get("version", ""), lic or "UNKNOWN", repo or "", pkg_dir))
        for field in ("dependencies", "optionalDependencies", "peerDependencies"):
            stack.extend((n, pkg_dir) for n in pj.get(field, {}))
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: third-party-licenses.py OUTPUT_FILE")
    sections, missing = [], []
    for kind, pkgs in (("Rust crate", rust_packages()), ("npm package", npm_packages())):
        for name, version, lic, repo, directory in sorted(pkgs, key=lambda p: (p[0], p[1])):
            texts = license_texts(directory)
            if not texts:
                missing.append(f"{name} {version}")
            body = "\n\n".join(f"--- {fname} ---\n{text}" for fname, text in texts) or \
                "(no license file shipped in the package; see the license expression above)"
            sections.append(f"{name} {version} ({kind})\nLicense: {lic}\nSource: {repo}\n\n{body}")

    header = ("Third-party software included in AndruiTerminal\n"
              "AndruiTerminal itself is licensed under GPL-3.0-or-later.\n"
              "The scrcpy server notice is in scrcpy-LICENSE / scrcpy-NOTICE.\n")
    sep = "\n\n" + "=" * 78 + "\n\n"
    Path(sys.argv[1]).write_text(header + sep + sep.join(sections) + "\n")
    print(f"Wrote {len(sections)} packages to {sys.argv[1]}", file=sys.stderr)
    if missing:
        print(f"No license file found for {len(missing)}: {', '.join(missing)}", file=sys.stderr)


if __name__ == "__main__":
    main()

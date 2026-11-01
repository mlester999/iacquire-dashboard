"""Tests for the operator scripts (ops/make-secrets.sh, ops/backup-profiles.sh, ops/restore-profiles.sh).

No Docker daemon, no age or gpg and no root are needed: the scripts run under bash with a PATH-shimmed fake `docker`, `age`, `gpg`, `chown`, `chmod`, `stat`, `mv`, `id` and `date`
that record what they were asked to do and answer from a JSON fixture. That checks the scripts' own logic (what they refuse, which flags every container gets, what they print); it does
not prove the real Docker commands behave the same, which only the sandbox on a Docker host can show.

The helpers at the top (`ShimWorld`, `bash_available`) are reused by test_preflight.py.
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
REPO = ROOT.parent.parent
OPS = ROOT / "ops"
PROFILES_SENTINEL = "PLAINTEXT-PROFILE-BYTES"

FAKE_DOCKER = r'''
import hashlib, json, os, re, sys

sys.stdout.reconfigure(newline="\n")
STATE = os.environ["FAKE_DOCKER_STATE"]
LOG = os.environ["FAKE_DOCKER_LOG"]


def load():
    with open(STATE, encoding="utf-8") as handle:
        return json.load(handle)


def save(state):
    with open(STATE, "w", encoding="utf-8") as handle:
        json.dump(state, handle)


def log(entry):
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def dig(obj, path):
    for part in path.split("."):
        if part == "":
            continue
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            return None
    return obj


def text(value):
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "<no value>"
    return str(value)


def render(template, ctx):
    template = re.sub(
        r"\{\{range \$k, \$v := \.([A-Za-z0-9_.]+)\}\}(.*?)\{\{end\}\}",
        lambda m: "".join(m.group(2).replace("{{$k}}", key) for key in (dig(ctx, m.group(1)) or {})),
        template, flags=re.S)

    def each(m):
        out = []
        for item in dig(ctx, m.group(1)) or []:
            out.append(re.sub(r"\{\{\.([A-Za-z0-9_.]+)\}\}", lambda f: text(dig(item, f.group(1))), m.group(2)))
        return "".join(out)

    template = re.sub(r"\{\{range \.([A-Za-z0-9_.]+)\}\}(.*?)\{\{end\}\}", each, template, flags=re.S)
    template = re.sub(r"\{\{json \.([A-Za-z0-9_.]+)\}\}", lambda m: json.dumps(dig(ctx, m.group(1)), separators=(",", ":")), template)
    return re.sub(r"\{\{\.([A-Za-z0-9_.]+)\}\}", lambda m: text(dig(ctx, m.group(1))), template)


def option(args, *names):
    for index, arg in enumerate(args):
        if arg in names and index + 1 < len(args):
            return args[index + 1]
    return None


def fail(message, code=1):
    sys.stderr.write(message + "\n")
    sys.exit(code)


def run_command(args, state):
    flags_with_value = {"--entrypoint", "-v", "--user", "--network", "--cap-add", "--cap-drop", "--security-opt", "--label"}
    index, mounts, entrypoint = 0, [], None
    while index < len(args) and args[index].startswith("-"):
        if args[index] in flags_with_value:
            if args[index] == "-v":
                mounts.append(args[index + 1])
            if args[index] == "--entrypoint":
                entrypoint = args[index + 1]
            index += 2
        else:
            index += 1
    image, rest = args[index], args[index + 1:]
    log({"cmd": "run", "argv": args})

    def volume_for(target):
        for mount in mounts:
            parts = mount.split(":")
            if parts[1] == target:
                return parts[0]
        return None

    if entrypoint == "tar" and "-cf" in rest:
        volume = volume_for("/src")
        sys.stdout.buffer.write(("PLAINTEXT-PROFILE-BYTES:" + volume).encode())
        return 0
    if entrypoint == "tar" and "-xpf" in rest:
        volume = volume_for("/dst")
        data = sys.stdin.buffer.read()
        if state.get("corrupt_extract"):
            data = data + b"x"
        entry = state["volumes"][volume]
        entry["empty"] = False
        entry["extracted_sha"] = hashlib.sha256(data).hexdigest()
        save(state)
        return 0
    if entrypoint == "/bin/sh":
        script = rest[rest.index("-c") + 1]
        if "ls -A" in script:
            return 0 if state["volumes"][volume_for("/t")].get("empty", True) else 1
        if "sha256sum" in script:
            volume = volume_for("/src")
            entry = state["volumes"][volume]
            digest = entry.get("extracted_sha") or hashlib.sha256(("PLAINTEXT-PROFILE-BYTES:" + volume).encode()).hexdigest()
            sys.stdout.write(digest + "  ./data.tar\n")
            return 0
    log({"cmd": "UNHANDLED", "argv": args})
    return 99


def main(argv):
    state = load()
    if not argv:
        fail("no command", 2)
    head = argv[0]
    rest = argv[1:]
    fmt = option(rest, "-f", "--format")
    if head == "version":
        if not state.get("server_version"):
            fail("Cannot connect to the Docker daemon")
        print(render(fmt, {"Server": {"Version": state["server_version"]}}))
        return 0
    if head == "compose" and rest[:1] == ["version"]:
        if not state.get("compose_version"):
            fail("docker: 'compose' is not a docker command")
        print(state["compose_version"])
        return 0
    if head == "info":
        print(render(fmt, state.get("info", {})))
        return 0
    if head == "inspect":
        name = rest[-1]
        container = state.get("containers", {}).get(name)
        if container is None:
            fail("Error: No such object: " + name)
        print(render(fmt, container))
        return 0
    if head == "ps":
        volume = None
        for index, arg in enumerate(rest):
            if arg == "--filter" and rest[index + 1].startswith("volume="):
                volume = rest[index + 1][len("volume="):]
        names = list(state.get("containers", {}))
        if volume is not None:
            names = state.get("volumes", {}).get(volume, {}).get("attached", [])
        for name in names:
            container = state["containers"].get(name, {"_ps": {"Image": "", "Ports": "", "Status": ""}})
            ctx = {"Names": name, **container.get("_ps", {})}
            print(render(fmt, ctx))
        return 0
    if head == "network" and rest[:1] == ["inspect"]:
        network = state.get("networks", {}).get(rest[-1])
        if network is None:
            fail("Error: No such network: " + rest[-1])
        print(render(fmt, network))
        return 0
    if head == "volume" and rest[:1] == ["inspect"]:
        if rest[-1] not in state.get("volumes", {}):
            fail("Error: No such volume: " + rest[-1])
        print(render(fmt, {"Name": rest[-1]}))
        return 0
    if head == "volume" and rest[:1] == ["create"]:
        log({"cmd": "volume create", "argv": rest})
        state.setdefault("volumes", {})[rest[-1]] = {"empty": True, "attached": [], "created_by_script": True}
        save(state)
        print(rest[-1])
        return 0
    if head == "image" and rest[:1] == ["inspect"]:
        image = state.get("images", {}).get(rest[-1])
        if image is None:
            fail("Error: No such image: " + rest[-1])
        print(render(fmt, image))
        return 0
    if head == "run":
        return run_command(rest, state)
    log({"cmd": "UNHANDLED", "argv": argv})
    return 99


sys.exit(main(sys.argv[1:]))
'''

FAKE_CRYPTO = r'''
import os, sys

LOG = os.environ["FAKE_CRYPTO_LOG"]
MAGIC = b"FAKE-CIPHERTEXT\n"
tool, args = sys.argv[1], sys.argv[2:]
with open(LOG, "a", encoding="utf-8") as handle:
    handle.write(tool + " " + " ".join(args) + "\n")


def option(*names):
    for index, arg in enumerate(args):
        if arg in names and index + 1 < len(args):
            return args[index + 1]
    return None


def encrypt(out):
    data = sys.stdin.buffer.read()
    with open(out, "wb") as handle:
        handle.write(MAGIC + bytes((byte + 13) % 256 for byte in data))


def decrypt(path):
    with open(path, "rb") as handle:
        blob = handle.read()
    if not blob.startswith(MAGIC):
        sys.stderr.write("not a ciphertext\n")
        sys.exit(1)
    sys.stdout.buffer.write(bytes((byte - 13) % 256 for byte in blob[len(MAGIC):]))


if tool == "age":
    if "-d" in args:
        if option("-i") is None:
            sys.exit(1)
        decrypt(args[-1])
    else:
        if option("-r") is None:
            sys.exit(1)
        encrypt(option("-o"))
elif tool == "gpg":
    if "--decrypt" in args:
        decrypt(args[-1])
    else:
        if option("--recipient") is None:
            sys.exit(1)
        encrypt(option("--output"))
'''

SHIM_DOCKER = r'''#!/bin/sh
exec "$FAKE_PY" "$FAKE_SHIM_DIR/fake_docker.py" "$@"
'''

SHIM_AGE = r'''#!/bin/sh
exec "$FAKE_PY" "$FAKE_SHIM_DIR/fake_crypto.py" age "$@"
'''

SHIM_GPG = r'''#!/bin/sh
exec "$FAKE_PY" "$FAKE_SHIM_DIR/fake_crypto.py" gpg "$@"
'''

# chown and chmod record the owner and mode the script asks for and stat reports them back, so a script that forgets one fails its own verification on any host, root or not.
SHIM_CHOWN = r'''#!/bin/sh
key=$(printf %s "$2" | cksum | cut -d" " -f1)
printf %s "$1" > "$SHIM_META/$key.owner"
printf "chown %s %s\n" "$1" "$2" >> "$SHIM_LOG"
'''

SHIM_CHMOD = r'''#!/bin/sh
printf "chmod %s %s\n" "$1" "$2" >> "$SHIM_LOG"
if [ -n "${SHIM_CHMOD_FAIL:-}" ]; then exit 0; fi
key=$(printf %s "$2" | cksum | cut -d" " -f1)
m=${1#0}
printf %s "$m" > "$SHIM_META/$key.mode"
/usr/bin/chmod "$@" 2>/dev/null || true
'''

# mv carries the recorded metadata to the new name, and honours -n (never replace) the way the real one does.
SHIM_MV = r'''#!/bin/sh
n=$#
eval "dst=\${$n}"
eval "src=\${$((n - 1))}"
ks=$(printf %s "$src" | cksum | cut -d" " -f1)
kd=$(printf %s "$dst" | cksum | cut -d" " -f1)
for ext in owner mode; do
  if [ -f "$SHIM_META/$ks.$ext" ]; then cp "$SHIM_META/$ks.$ext" "$SHIM_META/$kd.$ext"; fi
done
for a; do
  if [ "$a" = "-n" ] && [ -e "$dst" ]; then exit 0; fi
done
exec /usr/bin/mv "$@"
'''

SHIM_STAT = r'''#!/bin/sh
fmt=$2
for last; do :; done
key=$(printf %s "$last" | cksum | cut -d" " -f1)
if [ -f "$SHIM_META/$key.owner" ] && [ -f "$SHIM_META/$key.mode" ]; then
  case "$fmt" in
    %u:%g:%a) printf "%s:%s\n" "$(cat "$SHIM_META/$key.owner")" "$(cat "$SHIM_META/$key.mode")"; exit 0 ;;
    %a) cat "$SHIM_META/$key.mode"; echo; exit 0 ;;
  esac
fi
case "$fmt" in
  %a) if [ -d "$last" ]; then echo 700; exit 0; fi ;;
esac
exec /usr/bin/stat "$@"
'''

SHIM_ID = r'''#!/bin/sh
if [ "$1" = "-u" ]; then echo "${SHIM_UID:-0}"; exit 0; fi
exec /usr/bin/id "$@"
'''

SHIM_DATE = r'''#!/bin/sh
if [ "$1" = "-u" ] && [ "$2" = "+%Y%m%dT%H%M%SZ" ]; then echo "${SHIM_STAMP:-20261101T120000Z}"; exit 0; fi
exec /usr/bin/date "$@"
'''

SHIMS = {
    "docker": SHIM_DOCKER, "age": SHIM_AGE, "gpg": SHIM_GPG, "chown": SHIM_CHOWN, "chmod": SHIM_CHMOD,
    "mv": SHIM_MV, "stat": SHIM_STAT, "id": SHIM_ID, "date": SHIM_DATE,
}


def bash_available() -> str | None:
    """A bash that runs POSIX scripts (Git Bash or Linux bash). The WSL launcher that ships with Windows is not one."""
    path = shutil.which("bash")
    if not path:
        return None
    try:
        probe = subprocess.run([path, "-c", "echo ok; command -v sha256sum >/dev/null && command -v cksum >/dev/null && test -x /usr/bin/stat"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return path if probe.returncode == 0 and probe.stdout.strip() == "ok" else None


BASH = bash_available()


def posix(path: Path | str) -> str:
    return Path(path).as_posix()


class ShimWorld:
    """A temporary directory with the shims on PATH, a Docker fixture and the logs the shims write."""

    def __init__(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.shim_dir = self.root / "shim"
        self.meta_dir = self.root / "meta"
        self.shim_dir.mkdir()
        self.meta_dir.mkdir()
        (self.shim_dir / "fake_docker.py").write_text(FAKE_DOCKER, encoding="utf-8")
        (self.shim_dir / "fake_crypto.py").write_text(FAKE_CRYPTO, encoding="utf-8")
        for name, body in SHIMS.items():
            path = self.shim_dir / name
            path.write_bytes(body.encode("utf-8"))
            os.chmod(path, 0o755)
        self.docker_state = self.root / "docker_state.json"
        self.docker_log = self.root / "docker.log"
        self.crypto_log = self.root / "crypto.log"
        self.shim_log = self.root / "shim.log"
        self.state: dict = {"server_version": "27.3.1", "compose_version": "2.29.7", "volumes": {}, "containers": {}, "networks": {}, "images": {}, "info": {}}
        self.extra_env: dict[str, str] = {}
        for log in (self.docker_log, self.crypto_log, self.shim_log):
            log.write_text("", encoding="utf-8")

    def close(self) -> None:
        self.tmp.cleanup()

    def write_state(self) -> None:
        self.docker_state.write_text(json.dumps(self.state), encoding="utf-8")

    def read_state(self) -> dict:
        return json.loads(self.docker_state.read_text(encoding="utf-8"))

    def set_meta(self, path: Path, owner: str, mode: str) -> None:
        key = subprocess.run(["cksum"], input=posix(path), capture_output=True, text=True, check=True).stdout.split()[0]
        (self.meta_dir / f"{key}.owner").write_text(owner, encoding="utf-8")
        (self.meta_dir / f"{key}.mode").write_text(mode, encoding="utf-8")

    def env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["PATH"] = posix(self.shim_dir) + os.pathsep + env.get("PATH", "")
        # Git Bash rewrites arguments that look like POSIX paths ("/src") when it starts a Windows program; the fake docker must see them as written.
        env["MSYS_NO_PATHCONV"] = "1"
        env["MSYS2_ARG_CONV_EXCL"] = "*"
        env["FAKE_PY"] = posix(shutil.which("python") or "python")
        env["FAKE_SHIM_DIR"] = posix(self.shim_dir)
        env["FAKE_DOCKER_STATE"] = posix(self.docker_state)
        env["FAKE_DOCKER_LOG"] = posix(self.docker_log)
        env["FAKE_CRYPTO_LOG"] = posix(self.crypto_log)
        env["SHIM_META"] = posix(self.meta_dir)
        env["SHIM_LOG"] = posix(self.shim_log)
        env.update(self.extra_env)
        return env

    def run(self, script: Path, *args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
        self.write_state()
        assert BASH is not None
        return subprocess.run([BASH, posix(script), *args], env=self.env(), input=stdin, capture_output=True, text=True, timeout=120)

    def docker_calls(self) -> list[dict]:
        return [json.loads(line) for line in self.docker_log.read_text(encoding="utf-8").splitlines() if line.strip()]

    def runs(self) -> list[list[str]]:
        return [call["argv"] for call in self.docker_calls() if call["cmd"] == "run"]


def worker_model_key_names() -> set[str]:
    tree = ast.parse((ROOT / "worker.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "MODEL_API_KEY_ENV_NAMES" for t in node.targets):
            return set(ast.literal_eval(node.value))
    raise AssertionError("MODEL_API_KEY_ENV_NAMES was not found in worker.py")


NEW_SCRIPTS = [OPS / "make-secrets.sh", OPS / "backup-profiles.sh", OPS / "restore-profiles.sh", REPO / "scripts" / "hermes-client-preflight.sh"]


@unittest.skipUnless(BASH, "needs a POSIX bash")
class ScriptSyntaxTests(unittest.TestCase):
    def test_every_new_shell_script_passes_bash_n_and_is_lf_only(self):
        for script in NEW_SCRIPTS:
            raw = script.read_bytes()
            self.assertNotIn(b"\r\n", raw, script.name)
            self.assertTrue(raw.startswith(b"#!/usr/bin/env bash\n"), script.name)
            result = subprocess.run([BASH, "-n", posix(script)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, f"{script.name}: {result.stderr}")

    def test_no_script_turns_tracing_on_or_prints_with_echo_of_secrets(self):
        for script in NEW_SCRIPTS:
            body = script.read_text(encoding="utf-8")
            self.assertNotRegex(body, r"(?m)^\s*set\s+-[a-z]*x", script.name)
            self.assertNotIn("set -o xtrace", body, script.name)


@unittest.skipUnless(BASH, "needs a POSIX bash")
class MakeSecretsTests(unittest.TestCase):
    def setUp(self):
        self.world = ShimWorld()
        self.addCleanup(self.world.close)
        self.dir = self.world.root / "secrets"
        self.script = OPS / "make-secrets.sh"

    def make(self, *args: str, stdin: str = ""):
        return self.world.run(self.script, "--dir", posix(self.dir), *args, stdin=stdin)

    def meta_of(self, name: str) -> str:
        result = subprocess.run([BASH, "-c", 'key=$(printf %s "$1" | cksum | cut -d" " -f1); printf "%s:%s" "$(cat "$2/$key.owner")" "$(cat "$2/$key.mode")"', "x", posix(self.dir / name), posix(self.world.meta_dir)], capture_output=True, text=True)
        return result.stdout

    def test_creates_the_files_with_the_exact_owner_and_mode_and_prints_only_fingerprints(self):
        result = self.make()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.meta_of("config.yaml"), "0:10000:440")
        self.assertEqual(self.meta_of("hermes-api-key"), "0:10000:440")
        self.assertEqual(self.meta_of("provisioner-token"), "10000:10000:400")
        for name in ("config.yaml", "hermes-api-key", "provisioner-token"):
            self.assertRegex(result.stdout, rf"created .*{re.escape(name)}  owner=\d+:\d+ mode=0\d+  sha256:[0-9a-f]{{8}}\n")
        api_key = (self.dir / "hermes-api-key").read_text(encoding="utf-8")
        token = (self.dir / "provisioner-token").read_text(encoding="utf-8")
        self.assertRegex(api_key, r"^[0-9a-f]{64}$")
        self.assertRegex(token, r"^[0-9a-f]{64}$")
        self.assertNotEqual(api_key, token)
        for secret in (api_key, token):
            self.assertNotIn(secret, result.stdout)
            self.assertNotIn(secret, result.stderr)
        self.assertEqual((self.dir / "config.yaml").read_bytes(), (ROOT / "client-config.yaml.example").read_bytes())
        # The model key cannot be generated, so without it that file is reported as pending, not silently skipped.
        self.assertFalse((self.dir / "profile-model-env.json").exists())
        self.assertIn("pending: profile-model-env.json was not created", result.stdout)
        # Nothing is left behind next to the finished files.
        self.assertEqual(sorted(path.name for path in self.dir.iterdir()), ["config.yaml", "hermes-api-key", "provisioner-token"])

    def test_the_model_key_comes_from_stdin_goes_into_the_worker_document_and_is_never_printed(self):
        secret = "sk-FIXTURE-MODEL-KEY-0123456789"
        result = self.make("--model-env-name", "OPENAI_API_KEY", "--model-key-stdin", stdin=secret + "\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads((self.dir / "profile-model-env.json").read_text(encoding="utf-8"))
        self.assertEqual(document, {"schemaVersion": 1, "environment": "OPENAI_API_KEY", "value": secret})
        self.assertEqual(self.meta_of("profile-model-env.json"), "10000:10000:400")
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertNotIn("pending:", result.stdout)
        self.assertNotIn(secret, self.world.shim_log.read_text(encoding="utf-8"))

    def test_the_tunnel_token_comes_from_stdin_and_belongs_to_the_connector_user(self):
        token = "eyJ-FIXTURE-TUNNEL-TOKEN-" + "a" * 40
        result = self.make("--only", "tunnel-token", "--tunnel-token-stdin", stdin=token)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.meta_of("tunnel-token"), "65532:65532:400")
        self.assertEqual((self.dir / "tunnel-token").read_text(encoding="utf-8"), token)
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_refuses_to_overwrite_and_writes_nothing_when_any_file_exists(self):
        self.dir.mkdir(mode=0o700)
        existing = self.dir / "hermes-api-key"
        existing.write_text("a" * 64, encoding="utf-8")
        result = self.make()
        self.assertEqual(result.returncode, 1)
        self.assertIn("already exists", result.stderr)
        self.assertEqual(existing.read_text(encoding="utf-8"), "a" * 64)
        self.assertEqual(sorted(path.name for path in self.dir.iterdir()), ["hermes-api-key"])

    def test_a_second_run_refuses_and_changes_nothing(self):
        first = self.make()
        self.assertEqual(first.returncode, 0, first.stderr)
        before = {path.name: path.read_bytes() for path in self.dir.iterdir()}
        second = self.make()
        self.assertEqual(second.returncode, 1)
        self.assertEqual({path.name: path.read_bytes() for path in self.dir.iterdir()}, before)

    def test_refuses_a_model_key_name_the_worker_would_refuse_and_the_allowlists_match(self):
        result = self.make("--model-env-name", "HERMES_API_KEY", "--model-key-stdin", stdin="sk-FIXTURE-MODEL-KEY-0123456789")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not one of the model-provider key names", result.stderr)
        self.assertFalse(self.dir.exists() and any(self.dir.iterdir()))
        script = (OPS / "make-secrets.sh").read_text(encoding="utf-8")
        match = re.search(r'local allowed_names="([^"]+)"', script)
        self.assertIsNotNone(match)
        self.assertEqual(set(match.group(1).split()), worker_model_key_names())

    def test_refuses_a_model_key_with_characters_the_worker_refuses(self):
        for bad in ("short", 'has"quote-0123456789', "has space 0123456789", "has$dollar-0123456789"):
            result = self.make("--only", "model-env", "--model-env-name", "OPENAI_API_KEY", "--model-key-stdin", stdin=bad)
            self.assertEqual(result.returncode, 1, bad)
        self.assertFalse((self.dir / "profile-model-env.json").exists())

    def test_two_stdin_secrets_in_one_run_are_refused(self):
        result = self.make("--model-env-name", "OPENAI_API_KEY", "--model-key-stdin", "--tunnel-token-stdin", stdin="x")
        self.assertEqual(result.returncode, 1)
        self.assertIn("only one of", result.stderr)

    def test_needs_root_because_it_hands_files_to_other_users(self):
        self.world.extra_env["SHIM_UID"] = "1000"
        result = self.make()
        self.assertEqual(result.returncode, 1)
        self.assertIn("run as root", result.stderr)
        self.assertFalse(self.dir.exists())

    def test_a_file_whose_owner_or_mode_cannot_be_set_is_not_left_behind(self):
        self.world.extra_env["SHIM_CHMOD_FAIL"] = "1"
        result = self.make()
        self.assertEqual(result.returncode, 1)
        self.assertIn("could not set owner and mode", result.stderr)
        self.assertEqual([path.name for path in self.dir.iterdir()], [])

    def test_usage_errors_exit_2(self):
        self.assertEqual(self.world.run(self.script).returncode, 2)
        self.assertEqual(self.world.run(self.script, "--dir", posix(self.dir), "--nonsense").returncode, 2)


def encrypted_backup(world: ShimWorld, *extra: str, project: str = "iacquire-client-hermes") -> tuple[subprocess.CompletedProcess[str], Path]:
    out = world.root / "backups"
    out.mkdir(exist_ok=True)
    world.state["volumes"].update({f"{project}_client_profiles": {"empty": False, "attached": []}, f"{project}_worker_home": {"empty": False, "attached": []}})
    world.state["images"]["iacquire/hermes-client:acceptance"] = {"Id": "sha256:" + "d" * 64}
    args = ["--out-dir", posix(out), "--age-recipient", "age1" + "q" * 58, *extra]
    return world.run(OPS / "backup-profiles.sh", *args), out


@unittest.skipUnless(BASH, "needs a POSIX bash")
class BackupTests(unittest.TestCase):
    def setUp(self):
        self.world = ShimWorld()
        self.addCleanup(self.world.close)
        self.script = OPS / "backup-profiles.sh"

    def test_refuses_without_an_encryption_recipient_and_never_touches_docker_or_disk(self):
        out = self.world.root / "backups"
        out.mkdir()
        result = self.world.run(self.script, "--out-dir", posix(out))
        self.assertEqual(result.returncode, 1)
        self.assertIn("encryption recipient is required", result.stderr)
        self.assertIn("never writes a plaintext backup", result.stderr)
        self.assertEqual(list(out.iterdir()), [])
        self.assertEqual(self.world.docker_calls(), [])

    def test_refuses_two_recipient_kinds_a_malformed_recipient_and_a_missing_out_dir(self):
        out = self.world.root / "backups"
        out.mkdir()
        both = self.world.run(self.script, "--out-dir", posix(out), "--age-recipient", "age1" + "q" * 58, "--gpg-recipient", "ops@example.com")
        self.assertEqual(both.returncode, 1)
        bad = self.world.run(self.script, "--out-dir", posix(out), "--age-recipient", "not-a-key")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("age public key", bad.stderr)
        missing = self.world.run(self.script, "--out-dir", posix(out / "nope"), "--age-recipient", "age1" + "q" * 58)
        self.assertEqual(missing.returncode, 1)
        self.assertEqual(list(out.iterdir()), [])

    def test_writes_only_encrypted_files_and_a_header_with_matching_hashes(self):
        result, out = encrypted_backup(self.world)
        self.assertEqual(result.returncode, 0, result.stderr)
        names = sorted(path.name for path in out.iterdir())
        stamp = "20261101T120000Z"
        self.assertEqual(names, [
            f"client-runtime-{stamp}-profiles.manifest.age", f"client-runtime-{stamp}-profiles.tar.age",
            f"client-runtime-{stamp}-worker-state.manifest.age", f"client-runtime-{stamp}-worker-state.tar.age",
            f"client-runtime-{stamp}.header.txt",
        ])
        for path in out.iterdir():
            self.assertNotIn(PROFILES_SENTINEL.encode(), path.read_bytes(), path.name)
            if path.suffix == ".age":
                self.assertTrue(path.read_bytes().startswith(b"FAKE-CIPHERTEXT\n"))
        header = (out / f"client-runtime-{stamp}.header.txt").read_text(encoding="utf-8")
        self.assertIn("format=iacquire-client-runtime-backup/1", header)
        self.assertIn("compose_project=iacquire-client-hermes", header)
        for path in out.glob("*.age"):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertIn(f"file={path.name} sha256={digest} bytes={path.stat().st_size}", header)
        self.assertNotIn(PROFILES_SENTINEL, header + result.stdout + result.stderr)
        self.assertRegex(result.stdout, r"wrote .*profiles\.tar\.age  sha256:[0-9a-f]{8}\n")
        # The digest of the header itself is printed for the operator to record away from the backup folder; restore refuses to run without it.
        header_digest = hashlib.sha256((out / f"client-runtime-{stamp}.header.txt").read_bytes()).hexdigest()
        self.assertIn(f"--header-sha256): {header_digest}\n", result.stdout)

    def test_every_container_is_networkless_readonly_capless_and_mounts_the_volumes_read_only(self):
        result, _ = encrypted_backup(self.world)
        self.assertEqual(result.returncode, 0, result.stderr)
        runs = self.world.runs()
        self.assertEqual(len(runs), 4)
        for argv in runs:
            self.assertEqual(argv[argv.index("--network") + 1], "none", argv)
            self.assertIn("--read-only", argv)
            self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
            self.assertNotIn("--cap-add", argv)
            self.assertNotIn("--privileged", argv)
            self.assertEqual(argv[argv.index("--user") + 1], "10000:10000")
            mounts = [argv[i + 1] for i, arg in enumerate(argv) if arg == "-v"]
            self.assertEqual(len(mounts), 1)
            self.assertTrue(mounts[0].endswith(":/src:ro"), mounts)
        # The only Docker verbs used are reads and `run --rm`: nothing is started, stopped, removed or created.
        self.assertEqual({call["cmd"] for call in self.world.docker_calls()}, {"run"})
        self.assertTrue(all("--rm" in argv for argv in runs))

    def test_gpg_recipients_work_and_use_batch_mode(self):
        out = self.world.root / "backups"
        out.mkdir()
        self.world.state["volumes"].update({"iacquire-client-hermes_client_profiles": {"empty": False, "attached": []}, "iacquire-client-hermes_worker_home": {"empty": False, "attached": []}})
        result = self.world.run(self.script, "--out-dir", posix(out), "--gpg-recipient", "ops@example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(list(out.glob("*.gpg"))), 4)
        self.assertIn("--batch", self.world.crypto_log.read_text(encoding="utf-8"))
        for path in out.glob("*.gpg"):
            self.assertNotIn(PROFILES_SENTINEL.encode(), path.read_bytes())

    def test_refuses_while_the_worker_runs_unless_told_and_when_a_volume_is_missing(self):
        self.world.state["containers"]["iacquire-client-hermes-hermes-provisioner-1"] = {"State": {"Running": True}}
        result, out = encrypted_backup(self.world)
        self.assertEqual(result.returncode, 1)
        self.assertIn("worker is running", result.stderr)
        self.assertEqual(list(out.iterdir()), [])
        live, out = encrypted_backup(self.world, "--allow-running")
        self.assertEqual(live.returncode, 0, live.stderr)
        self.assertEqual(len(list(out.glob("*.age"))), 4)

        other = ShimWorld()
        self.addCleanup(other.close)
        out2 = other.root / "backups"
        out2.mkdir()
        gone = other.run(self.script, "--out-dir", posix(out2), "--age-recipient", "age1" + "q" * 58)
        self.assertEqual(gone.returncode, 1)
        self.assertIn("does not exist on this host", gone.stderr)

    def test_never_overwrites_an_existing_backup_and_leaves_no_partial_file_after_a_failure(self):
        result, out = encrypted_backup(self.world)
        self.assertEqual(result.returncode, 0, result.stderr)
        first = {path.name: path.read_bytes() for path in out.iterdir()}
        again = self.world.run(self.script, "--out-dir", posix(out), "--age-recipient", "age1" + "q" * 58)
        self.assertEqual(again.returncode, 1)
        self.assertIn("already exists", again.stderr)
        self.assertEqual({path.name: path.read_bytes() for path in out.iterdir()}, first)

        failing = ShimWorld()
        self.addCleanup(failing.close)
        failing.extra_env["SHIM_STAMP"] = "20261102T000000Z"
        out2 = failing.root / "backups"
        out2.mkdir()
        failing.state["volumes"].update({"iacquire-client-hermes_client_profiles": {"empty": False, "attached": []}})
        stopped = failing.run(self.script, "--out-dir", posix(out2), "--age-recipient", "age1" + "q" * 58)
        self.assertEqual(stopped.returncode, 1)
        self.assertEqual(list(out2.iterdir()), [])


@unittest.skipUnless(BASH, "needs a POSIX bash")
class RestoreTests(unittest.TestCase):
    TARGET = "restored-client-hermes"

    def setUp(self):
        self.world = ShimWorld()
        self.addCleanup(self.world.close)
        result, self.out = encrypted_backup(self.world)
        assert result.returncode == 0, result.stderr
        self.prefix = self.out / "client-runtime-20261101T120000Z"
        self.identity = self.world.root / "identity.txt"
        self.identity.write_text("AGE-SECRET-KEY-FIXTURE-NOT-REAL\n", encoding="utf-8")
        self.script = OPS / "restore-profiles.sh"
        # The restore starts from a clean log: only what the restore itself asks of Docker is judged.
        self.world.docker_log.write_text("", encoding="utf-8")

    def header_sha(self) -> str:
        return hashlib.sha256(self.prefix.with_name(self.prefix.name + ".header.txt").read_bytes()).hexdigest()

    def restore(self, *extra: str, target: str | None = None, header_sha: str | None = None):
        return self.world.run(self.script, "--backup", posix(self.prefix), "--age-identity", posix(self.identity), "--target-project", target or self.TARGET,
                              "--header-sha256", header_sha or self.header_sha(), *extra)

    def test_restores_into_new_volumes_verifies_them_and_labels_them_for_compose(self):
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"restored and verified {self.TARGET}_client_profiles", result.stdout)
        self.assertIn(f"restored and verified {self.TARGET}_worker_home", result.stdout)
        creates = [call["argv"] for call in self.world.docker_calls() if call["cmd"] == "volume create"]
        self.assertEqual(len(creates), 2)
        for argv in creates:
            self.assertIn(f"com.docker.compose.project={self.TARGET}", argv)
        state = self.world.read_state()
        self.assertFalse(state["volumes"][f"{self.TARGET}_client_profiles"]["empty"])
        self.assertNotIn(PROFILES_SENTINEL, result.stdout + result.stderr)

    def test_the_extraction_container_has_no_network_a_read_only_root_and_only_the_target_volume(self):
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        extractions = [argv for argv in self.world.runs() if "-xpf" in argv]
        self.assertEqual(len(extractions), 2)
        for argv in extractions:
            self.assertEqual(argv[argv.index("--network") + 1], "none")
            self.assertIn("--read-only", argv)
            self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
            self.assertEqual({argv[i + 1] for i, arg in enumerate(argv) if arg == "--cap-add"}, {"CHOWN", "FOWNER", "DAC_OVERRIDE"})
            mounts = [argv[i + 1] for i, arg in enumerate(argv) if arg == "-v"]
            self.assertEqual(len(mounts), 1)
            self.assertTrue(mounts[0].startswith(f"{self.TARGET}_") and mounts[0].endswith(":/dst"), mounts)
            self.assertNotIn("--privileged", argv)
        for argv in self.world.runs():
            self.assertEqual(argv[argv.index("--network") + 1], "none")

    def test_refuses_a_non_empty_target_and_writes_nothing(self):
        self.world.state["volumes"][f"{self.TARGET}_client_profiles"] = {"empty": False, "attached": []}
        result = self.restore()
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not empty", result.stderr)
        self.assertFalse([argv for argv in self.world.runs() if "-xpf" in argv])
        self.assertEqual([c for c in self.world.docker_calls() if c["cmd"] == "volume create"], [])

    def test_refuses_a_target_volume_attached_to_a_container(self):
        self.world.state["volumes"][f"{self.TARGET}_worker_home"] = {"empty": True, "attached": ["live-container"]}
        self.world.state["containers"]["live-container"] = {"_ps": {"Image": "x", "Ports": "", "Status": "Up"}}
        result = self.restore()
        self.assertEqual(result.returncode, 1)
        self.assertIn("attached to a container", result.stderr)
        self.assertFalse([argv for argv in self.world.runs() if "-xpf" in argv])

    def test_checks_both_targets_before_it_creates_or_writes_either(self):
        # The profiles volume would be new, the worker state volume is not empty: nothing at all may be created or extracted.
        self.world.state["volumes"][f"{self.TARGET}_worker_home"] = {"empty": False, "attached": []}
        result = self.restore()
        self.assertEqual(result.returncode, 1)
        self.assertEqual([c for c in self.world.docker_calls() if c["cmd"] == "volume create"], [])
        self.assertFalse([argv for argv in self.world.runs() if "-xpf" in argv])
        self.assertNotIn(f"{self.TARGET}_client_profiles", self.world.read_state()["volumes"])

    def test_refuses_to_restore_over_the_live_volumes_of_the_original_project(self):
        result = self.restore(target="iacquire-client-hermes")
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not empty", result.stderr)
        self.assertFalse([argv for argv in self.world.runs() if "-xpf" in argv])

    def test_a_damaged_or_changed_backup_file_is_refused_before_anything_runs(self):
        victim = self.prefix.with_name(self.prefix.name + "-profiles.tar.age")
        victim.write_bytes(victim.read_bytes() + b"x")
        result = self.restore()
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not match the sha256 in the header", result.stderr)
        self.assertEqual(self.world.docker_calls(), [])

    def test_the_restore_will_not_run_without_the_recorded_header_digest(self):
        digest = self.header_sha()
        none = self.world.run(self.script, "--backup", posix(self.prefix), "--age-identity", posix(self.identity), "--target-project", self.TARGET)
        self.assertEqual(none.returncode, 1)
        self.assertIn("--header-sha256", none.stderr)
        self.assertEqual(self.world.docker_calls(), [])
        short = self.restore(header_sha=digest[:40])
        self.assertEqual(short.returncode, 1)
        self.assertEqual(self.world.docker_calls(), [])

    def test_a_forged_backup_with_a_matching_forged_header_is_refused_before_anything_runs(self):
        # Someone who can write to the backup folder replaces the archive and rewrites the header's hashes to match: the ciphertext check passes, the pinned header digest does not.
        recorded = self.header_sha()
        victim = self.prefix.with_name(self.prefix.name + "-profiles.tar.age")
        forged = b"FAKE-CIPHERTEXT\nforged profile data"
        victim.write_bytes(forged)
        header = self.prefix.with_name(self.prefix.name + ".header.txt")
        lines = []
        for line in header.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"file={victim.name} "):
                line = f"file={victim.name} sha256={hashlib.sha256(forged).hexdigest()} bytes={len(forged)}"
            lines.append(line)
        header.write_text("\n".join(lines) + "\n", encoding="utf-8")
        refused = self.restore(header_sha=recorded)
        self.assertEqual(refused.returncode, 1)
        self.assertIn("does not match --header-sha256", refused.stderr)
        self.assertEqual(self.world.docker_calls(), [])
        self.assertFalse([argv for argv in self.world.runs() if "-xpf" in argv])

    def test_a_restore_whose_files_differ_from_the_manifest_fails_loudly(self):
        self.world.state["corrupt_extract"] = True
        result = self.restore()
        self.assertEqual(result.returncode, 1)
        self.assertIn("verification FAILED", result.stderr)
        self.assertNotIn("restored and verified", result.stdout)

    def test_needs_the_identity_and_a_header_it_wrote(self):
        none = self.world.run(self.script, "--backup", posix(self.prefix), "--target-project", self.TARGET)
        self.assertEqual(none.returncode, 1)
        self.assertIn("--age-identity", none.stderr)
        missing = self.world.run(self.script, "--backup", posix(self.prefix) + "-nope", "--age-identity", posix(self.identity), "--target-project", self.TARGET)
        self.assertEqual(missing.returncode, 1)
        self.assertEqual(self.world.run(self.script).returncode, 2)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Opt-in contract check against the installed Codex, using ONLY a dummy
loopback provider, private fixture HOME/config/project, and test tmux socket.
No real API credentials, paid inference, owner history or production job access.
Run on Linux: python3 tests/codex-native-restart.py
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CODEX = shutil.which("codex")
if not CODEX:
    raise SystemExit("Codex is required for this optional isolated contract test")
BASE = Path(tempfile.mkdtemp(prefix="pt-native-restart-"))
SOCKET = "pt-test-codex-native"
NAME = "pt_" + "e" * 32
HOME, PROJECT = BASE / "home", BASE / "project"
HOME.mkdir(mode=0o700)
PROJECT.mkdir(mode=0o700)
CODEX_HOME = HOME / ".codex"
CODEX_HOME.mkdir(mode=0o700)
ENV = {"HOME": str(HOME), "CODEX_HOME": str(CODEX_HOME), "PATH": "/usr/local/bin:/usr/bin:/bin",
       "TERM": "xterm-256color", "LANG": "C.UTF-8", "TMUX_TMPDIR": str(BASE),
       "PT_SYNTHETIC_KEY": "not-a-real-key"}
CONFIG = f'''model = "gpt-6-astra"
model_provider = "fixture"
check_for_update_on_startup = false
[agents]
max_concurrent_threads_per_session = LIMIT
[model_providers.fixture]
name = "Synthetic loopback only"
base_url = "http://127.0.0.1:9/v1"
env_key = "PT_SYNTHETIC_KEY"
wire_api = "responses"
[projects."{PROJECT}"]
trust_level = "trusted"
'''
(CODEX_HOME / "config.toml").write_text(CONFIG.replace("LIMIT", "2"))
(BASE / "tmux.conf").write_text("set -g remain-on-exit on\nset -s exit-empty off\nset -g history-limit 2000\n")


def tm(*args):
    return subprocess.run(["tmux", "-L", SOCKET, *args], env=ENV, capture_output=True, text=True, timeout=5)


def pane():
    return tm("display-message", "-p", "-t", "=" + NAME + ":0.0",
              "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}").stdout.strip().split("\t")


def control(*args):
    result = subprocess.run(["python3", "-I", str(ROOT / "scripts/codex-control.py"), *args],
                            env=ENV, capture_output=True, text=True, timeout=12)
    return json.loads(result.stdout)


def type_line(target, value):
    tm("send-keys", "-t", target, "-l", value)
    # Codex intentionally treats Enter in a paste burst as a newline. Simulate
    # a separate human Enter action instead of accidentally leaving a draft.
    time.sleep(0.5)
    tm("send-keys", "-t", target, "Enter")


def saved_prompts():
    # The wire record names vary across CLI versions; count only the known
    # synthetic marker, never load or inspect any owner history.
    return sum("Synthetic loopback-only restart verification." in line
               for file in CODEX_HOME.glob("sessions/**/*.jsonl") for line in file.read_text().splitlines())


report = {"fixtureOnly": True, "paidInference": False, "provider": "loopback port 9 only"}
try:
    assert tm("-f", str(BASE / "tmux.conf"), "new-session", "-d", "-s", NAME, "-c", str(PROJECT), "--",
              CODEX, "--no-alt-screen", "--sandbox", "read-only", "--ask-for-approval", "on-request").returncode == 0
    time.sleep(3)
    old = pane()
    type_line(old[0], "Synthetic loopback-only restart verification.")
    until = time.monotonic() + 6
    while time.monotonic() < until and not list(CODEX_HOME.glob("sessions/**/*.jsonl")):
        time.sleep(0.1)
    identity = control("inspect", old[1], str(PROJECT))
    assert "threadId" in identity, identity.get("error")
    tm("send-keys", "-t", old[0], "-l", "UNSENT_SYNTHETIC_DRAFT")
    time.sleep(0.5)
    result = control("exit", old[1], str(PROJECT), json.dumps(identity), SOCKET, old[0], NAME)
    report["firstExit"] = result
    assert result.get("exited") is True
    time.sleep(0.15)
    report["normalExitStatus"] = pane()[3]
    assert pane()[2:] == ["1", "0"]
    before_prompts = saved_prompts()
    (CODEX_HOME / "config.toml").write_text(CONFIG.replace("LIMIT", "30"))
    assert tm("respawn-pane", "-t", old[0], "-c", str(PROJECT), "--", CODEX, "resume", identity["threadId"],
              "--strict-config", "--no-alt-screen", "--sandbox", "read-only", "--ask-for-approval", "on-request",
              "--cd", str(PROJECT)).returncode == 0
    time.sleep(3)
    new = pane()
    resumed = control("inspect", new[1], str(PROJECT))
    report.update(sameConversation=resumed.get("threadId") == identity["threadId"], newProcess=new[1] != old[1], samePane=new[0] == old[0])
    assert report["sameConversation"] and report["newProcess"] and report["samePane"]
    # Reading only synthetic history is safe here; the production helper never
    # reads records after session_meta. Resume must not submit another prompt.
    prompts = saved_prompts()
    report["savedUserPrompts"] = prompts
    report["noPromptReplay"] = prompts == before_prompts
    assert report["noPromptReplay"]
    type_line(new[0], "/debug-config")
    time.sleep(0.5)
    output = tm("capture-pane", "-p", "-t", new[0], "-S", "-1900").stdout
    report["currentConfigVisible"] = bool(re.search(r"max_concurrent_threads_per_session\s*=\s*30", output))
    report["configLimitChanged"] = [2, 30]
    report["finalExit"] = control("exit", new[1], str(PROJECT), json.dumps(resumed), SOCKET, new[0], NAME)
    assert report["finalExit"].get("exited") is True
    report["passed"] = True
finally:
    tm("kill-server")  # Only this private synthetic socket.
    evidence = ROOT / ".runtime/evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "codex-native-restart.json").write_text(json.dumps(report, indent=2))
    shutil.rmtree(BASE)
    print(json.dumps(report))

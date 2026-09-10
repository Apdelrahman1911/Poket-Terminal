#!/usr/bin/env python3
"""On-demand Linux Codex identity/exit helper. Never reads or prints a transcript.

Only bounded session_meta headers of files already open by the exact native
Codex process are inspected. Sub-agent rollouts are not resumable main chats.
No directory-wide history search, shell, resident watcher, or forced job kill.
"""
import json
import os
import re
import select
import stat
import subprocess
import sys
import time

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ROLLOUT = re.compile(r"rollout-[^/]+-(" + UUID.pattern + r")\.jsonl")


class Refuse(Exception):
    pass


def bounded(file, limit):
    with open(file, "rb") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise Refuse("codex_inspection_limit")
    return value


def identity(pid):
    value = bounded(f"/proc/{pid}/stat", 4096).decode()
    fields = value[value.rfind(")") + 2:].split()
    if fields[0] == "Z" or os.stat(f"/proc/{pid}").st_uid != os.geteuid():
        raise Refuse("codex_target_changed")
    return {"parent": int(fields[1]), "start": fields[19]}


def executable(pid):
    return os.path.basename(os.readlink(f"/proc/{pid}/exe"))


def native(pane_pid):
    if executable(pane_pid) == "codex":
        return pane_pid
    # npm's documented launcher is Node -> the native Codex binary. Never
    # descend through a generic shell/tool tree or pick a worker/sub-agent.
    if executable(pane_pid) not in ("node", "nodejs"):
        raise Refuse("codex_not_directly_managed")
    argv = bounded(f"/proc/{pane_pid}/cmdline", 8192).split(b"\0")
    if len(argv) < 2 or not os.path.realpath(os.fsdecode(argv[1])).endswith("/@openai/codex/bin/codex.js"):
        raise Refuse("codex_not_directly_managed")
    children = []
    # Some container kernels omit /proc/PID/task/PID/children. Stream a bounded
    # process inventory instead; retain only matching direct child PIDs.
    with os.scandir("/proc") as entries:
        for count, entry in enumerate(entries):
            if count >= 8192:
                raise Refuse("codex_inspection_limit")
            if not entry.name.isdecimal():
                continue
            try:
                pid = int(entry.name)
                child = identity(pid)
                is_codex = child["parent"] == pane_pid and executable(pid) == "codex"
            except (OSError, ValueError, IndexError, Refuse):
                continue
            if is_codex:
                children.append(pid)
                if len(children) > 1:
                    raise Refuse("codex_target_ambiguous")
    if len(children) != 1:
        raise Refuse("codex_not_directly_managed")
    return children[0]


def main_thread(pid, cwd):
    found = set()
    candidates = 0
    with os.scandir(f"/proc/{pid}/fd") as entries:
        for count, entry in enumerate(entries):
            if count >= 1024:
                raise Refuse("codex_inspection_limit")
            try:
                target = os.readlink(entry.path)
            except FileNotFoundError:
                continue  # unrelated descriptors can close during inspection
            try:
                match = ROLLOUT.fullmatch(os.path.basename(target))
                if not match or not os.path.isabs(target):
                    continue
                candidates += 1
                if candidates > 128:
                    raise Refuse("codex_inspection_limit")
                fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise Refuse("codex_history_unavailable")
                    header = stream.readline(128 * 1024 + 1)
                if len(header) > 128 * 1024 or not header.endswith(b"\n"):
                    raise Refuse("codex_inspection_limit")
                record = json.loads(header)
                payload = record.get("payload", {})
                if record.get("type") != "session_meta" or not isinstance(payload, dict):
                    raise Refuse("codex_history_unavailable")
                if payload.get("source") != "cli":
                    continue
                if payload.get("id") != match[1] or not isinstance(payload.get("cwd"), str):
                    raise Refuse("codex_history_unavailable")
                if os.path.realpath(payload["cwd"]) != os.path.realpath(cwd):
                    raise Refuse("codex_directory_changed")
                found.add(match[1])
            except FileNotFoundError:
                raise Refuse("codex_target_changed")
    if len(found) != 1:
        raise Refuse("codex_history_unavailable" if not found else "codex_target_ambiguous")
    return next(iter(found))


def inspect(pane_pid, cwd):
    pane_before = identity(pane_pid)
    pid = native(pane_pid)
    before = identity(pid)
    thread = main_thread(pid, cwd)
    if identity(pane_pid) != pane_before or identity(pid) != before:
        raise Refuse("codex_target_changed")
    return {"panePid": pane_pid, "paneStart": pane_before["start"],
            "pid": pid, "start": before["start"], "threadId": thread}


def main():
    if len(sys.argv) not in (4, 8) or sys.argv[1] not in ("inspect", "exit"):
        raise Refuse("codex_invalid_control")
    pane_pid = int(sys.argv[2])
    if pane_pid < 1 or not os.path.isabs(sys.argv[3]) or len(sys.argv[3]) > 4096:
        raise Refuse("codex_invalid_control")
    snapshot = inspect(pane_pid, sys.argv[3])
    if sys.argv[1] == "inspect":
        return snapshot
    if len(sys.argv) != 8 or len(sys.argv[4]) > 1024 or json.loads(sys.argv[4]) != snapshot:
        raise Refuse("codex_target_changed")
    socket, pane, session_name = sys.argv[5:8]
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", socket) or not re.fullmatch(r"%[0-9]+", pane) or not re.fullmatch(r"pt_[a-f0-9]{32}", session_name):
        raise Refuse("codex_invalid_control")
    # Monitor the exact process instance, but send NO Unix signal to Codex.
    # The CLI's own Ctrl+C sequence clears a draft/interrupts/then exits normally,
    # allowing it to save state and shut down child services. SIGTERM is not a
    # graceful TUI shutdown on the supported CLI. No /quit text or prompt replay.
    try:
        fd = os.pidfd_open(snapshot["pid"])
    except (AttributeError, OSError):
        raise Refuse("codex_safe_exit_unavailable")
    try:
        if identity(snapshot["pid"])["start"] != snapshot["start"]:
            raise Refuse("codex_target_changed")
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        def gone():
            if poll.poll(0):
                return True
            # Container kernels can delay pidfd readiness. A missing/reused PID
            # or a zombie also proves this instance ended; no PID is signalled.
            try:
                raw = bounded(f"/proc/{snapshot['pid']}/stat", 4096).decode()
            except FileNotFoundError:
                return True
            fields = raw[raw.rfind(")") + 2:].split()
            return fields[0] == "Z" or fields[19] != snapshot["start"]
        def wait_exit(ms):
            deadline = time.monotonic() + ms / 1000
            while not gone():
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.025)
            return True
        condition = ("#{&&:#{&&:#{==:#{session_name}," + session_name + "},#{==:#{pane_id}," + pane
                     + "}},#{&&:#{==:#{pane_pid}," + str(pane_pid) + "},#{==:#{pane_dead},0}}}")
        command = ("if-shell -F -t " + pane + " '#{pane_in_mode}' 'send-keys -X -t " + pane
                   + " cancel' '' ; send-keys -t " + pane + " C-c ; display-message -p PT_CODEX_EXIT_SENT")
        for _ in range(4):
            if gone():
                break
            try:
                current = inspect(pane_pid, sys.argv[3])
            except (Refuse, OSError):
                if wait_exit(4000):
                    break
                raise Refuse("codex_target_changed")
            if current != snapshot:
                raise Refuse("codex_target_changed")
            result = subprocess.run(["tmux", "-L", socket, "if-shell", "-F", "-t", pane, condition,
                                     command, "display-message -p PT_CODEX_TARGET_CHANGED"],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1.5)
            # The fixed format branches print only these small constant markers.
            if result.returncode or result.stdout.strip() != b"PT_CODEX_EXIT_SENT":
                if wait_exit(4000):
                    break
                raise Refuse("codex_target_changed")
            if wait_exit(250):
                break
        if not wait_exit(4000):
            raise Refuse("codex_exit_timeout")
    finally:
        os.close(fd)
    return {"exited": True}


if __name__ == "__main__":
    try:
        print(json.dumps(main(), separators=(",", ":")))
    except Refuse as error:
        print(json.dumps({"error": str(error)}))
    except Exception:
        # Never log file headers, provider configuration, argv, or exceptions.
        print('{"error":"codex_inspection_unavailable"}')

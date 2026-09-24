#!/usr/bin/env python3
"""GBX Claude helper - on-demand `claude -p` over a Unix socket (host side).

The CRM runs in Docker and must NOT hold your Claude credentials. This tiny
service runs on the host, owns the `claude` binary and your subscription login,
and answers one request at a time over a local Unix socket. The CRM container
mounts that socket and calls it when someone clicks an AI button. No API key, no
TCP port, nothing public - the socket file's permissions are the boundary.

Config - env or an env file (CRM_AGENT_ENV, default /root/crm-agent.env):
  CLAUDE_BIN            default /root/.local/bin/claude
  CLAUDE_HELPER_SOCKET  default /root/gbx-claude/claude.sock   (HOST path)
  CLAUDE_HELPER_TOKEN   optional shared secret (Bearer) for defence in depth
  CLAUDE_MODEL          default sonnet
Run it under systemd (deploy/agent/gbx-claude-helper.service).

Request:  POST / {"prompt": "...", "model": "sonnet"}
Response: 200 {"text": "..."}  |  4xx/5xx {"error": "..."}
"""
import json
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingMixIn, UnixStreamServer

envf = os.environ.get("CRM_AGENT_ENV", "/root/crm-agent.env")
if os.path.exists(envf):
    with open(envf, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip("\"'")

CLAUDE = os.environ.get("CLAUDE_BIN", "/root/.local/bin/claude")
SOCKPATH = os.environ.get("CLAUDE_HELPER_SOCKET", "/root/gbx-claude/claude.sock")
TOKEN = os.environ.get("CLAUDE_HELPER_TOKEN", "")
DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")
HOME = os.environ.get("HOME", "/root")


def run_claude(prompt, model):
    out = subprocess.run(
        [CLAUDE, "-p", prompt, "--model", model, "--output-format", "json"],
        capture_output=True, text=True, timeout=170, cwd=HOME,
    )
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[:300] or "claude failed")
    text = out.stdout
    try:
        env = json.loads(out.stdout)
        if isinstance(env, dict) and isinstance(env.get("result"), str):
            text = env["result"]
    except Exception:
        pass
    return text


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            if TOKEN and self.headers.get("authorization", "") != "Bearer " + TOKEN:
                return self._send(401, {"error": "unauthorized"})
            n = int(self.headers.get("content-length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
            prompt = (data.get("prompt") or "").strip()
            if not prompt:
                return self._send(400, {"error": "prompt required"})
            text = run_claude(prompt, data.get("model") or DEFAULT_MODEL)
            self._send(200, {"text": text})
        except subprocess.TimeoutExpired:
            self._send(504, {"error": "claude timeout"})
        except Exception as e:
            self._send(500, {"error": str(e)[:300]})


class Server(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True


def main():
    os.makedirs(os.path.dirname(SOCKPATH), exist_ok=True)
    try:
        os.unlink(SOCKPATH)
    except FileNotFoundError:
        pass
    srv = Server(SOCKPATH, Handler)
    os.chmod(SOCKPATH, 0o666)  # the CRM container (non-root uid) must be able to connect
    print(f"[claude-helper] listening on {SOCKPATH} (default model {DEFAULT_MODEL})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"[claude-helper] {e}\n")
        sys.exit(1)

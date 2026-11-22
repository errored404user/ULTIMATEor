#!/usr/bin/env python3
"""Fast, reliable one-shot JSON round-trip to the blender-mcp addon (TCP 9876).

  blender_once.py --probe
  blender_once.py IN.json OUT.json
"""
from __future__ import annotations

import json
import os
import socket
import sys

HOST = os.environ.get("BLENDER_HOST", "127.0.0.1")
PORT = int(os.environ.get("BLENDER_PORT", "9876"))
RECV_CHUNK = 65536
WRAP = 3000


def probe() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2.5)
    try:
        s.connect((HOST, PORT))
        print("BLENDER_UP", flush=True)
        return 0
    except OSError:
        print("BLENDER_DOWN", flush=True)
        return 1
    finally:
        try:
            s.close()
        except OSError:
            pass


class _JsonFrameScanner:
    """O(N) incremental scanner that tracks JSON nesting depth outside strings so
    multi-megabyte mesh dumps are only handed to json.loads() once complete."""

    def __init__(self) -> None:
        self.depth = 0
        self.in_str = False
        self.escape = False
        self.started = False

    def feed(self, chunk: bytes) -> bool:
        for b in chunk:
            if self.in_str:
                if self.escape:
                    self.escape = False
                elif b == 92:  # '\\'
                    self.escape = True
                elif b == 34:  # '"'
                    self.in_str = False
                continue
            if b == 34:  # '"'
                self.in_str = True
            elif b in (123, 91):  # '{' or '['
                self.depth += 1
                self.started = True
            elif b in (125, 93):  # '}' or ']'
                self.depth -= 1
        return self.started and not self.in_str and self.depth <= 0


def recv_json(sock: socket.socket, timeout: float = 180.0) -> dict:
    sock.settimeout(timeout)
    buf = bytearray()
    scanner = _JsonFrameScanner()
    while True:
        chunk = sock.recv(RECV_CHUNK)
        if not chunk:
            if not buf:
                raise ConnectionError("Blender closed the socket before sending data")
            break
        buf.extend(chunk)
        if scanner.feed(chunk):
            try:
                return json.loads(buf.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
    try:
        return json.loads(buf.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise ValueError(f"incomplete JSON from Blender ({len(buf)} bytes): {e}") from e


def write_wrapped(path: str, text: str) -> None:
    """TotalScript reads this file through total-core's read_file, which clips a single read
    at 40k characters - a mesh dump is one long JSON line, so it was silently
    truncated. Write <= WRAP-char lines (JSON never contains raw newlines, so TotalScript
    just joins the lines back together)."""
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(text[i:i + WRAP] for i in range(0, len(text), WRAP)))


def send_file(in_path: str, out_path: str) -> int:
    with open(in_path, "r", encoding="utf-8") as f:
        req = json.load(f)
    if not isinstance(req, dict):
        raise ValueError("request must be a JSON object")
    payload = json.dumps(
        {"type": req.get("type") or req.get("command"), "params": req.get("params") or {}},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    sock = socket.create_connection((HOST, PORT), 8.0)
    try:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        sock.sendall(payload)
        data = recv_json(sock)
    finally:
        try:
            sock.close()
        except OSError:
            pass
    write_wrapped(out_path, json.dumps(data, ensure_ascii=True))
    print("TOTAL_BLENDER_OK", flush=True)
    return 0


def main(argv: list[str]) -> int:
    if "--probe" in argv or (len(argv) == 1):
        return probe()
    if len(argv) < 3:
        print("usage: blender_once.py --probe | IN.json OUT.json", file=sys.stderr)
        return 2
    try:
        return send_file(argv[1], argv[2])
    except Exception as e:
        err = {"status": "error", "message": str(e)}
        try:
            with open(argv[2], "w", encoding="utf-8") as f:
                json.dump(err, f)
        except OSError:
            pass
        print("TOTAL_BLENDER_ERR " + str(e), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

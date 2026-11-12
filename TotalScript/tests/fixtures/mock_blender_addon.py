#!/usr/bin/env python3
"""Mock of the blender-mcp addon socket (tests only). Speaks the real wire
format: one JSON request per connection, one JSON reply. execute_code really
executes the submitted Python with the fake bpy on sys.path and returns the
captured stdout exactly like addon.py does ({"executed": true, "result": out})."""
import contextlib, io, json, os, socket, sys, traceback

port = int(sys.argv[1])
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "fakebpy"))
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(8)
print("READY", flush=True)
while True:
    c, _ = s.accept()
    data = b""
    c.settimeout(10)
    try:
        while True:
            ch = c.recv(8192)
            if not ch: break
            data += ch
            try:
                json.loads(data.decode()); break
            except Exception:
                pass
        req = json.loads(data.decode()) if data else {}
        t = req.get("type"); p = req.get("params") or {}
        if t == "get_scene_info":
            resp = {"status": "success", "result": {"name": "Scene", "object_count": 4, "objects": [{"name": "Cube", "type": "MESH"}]}}
        elif t == "execute_code":
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf):
                    exec(p.get("code", ""), {"__name__": "__total__"})
                resp = {"status": "success", "result": {"executed": True, "result": buf.getvalue()}}
            except Exception as e:
                resp = {"status": "error", "message": json.dumps({"exception_type": type(e).__name__, "message": str(e), "traceback": traceback.format_exc()})}
        else:
            resp = {"status": "error", "message": "Unknown command type: " + str(t)}
        c.sendall(json.dumps(resp).encode())
    except Exception:
        pass
    try: c.close()
    except Exception: pass

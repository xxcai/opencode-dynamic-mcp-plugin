#!/usr/bin/env python3
"""同实例双 session 验证：A 装配技能 → B（未装配）应能看到 skill-* 工具（instance 级）+ B 重复 prepare 幂等"""
import json
import urllib.request

BASE = "http://127.0.0.1:14096"
DIR = "/Users/caixiao/Workspace/projects/opencode-dynamic-mcp-plugin/demo"
HEADERS = {"content-type": "application/json", "x-opencode-directory": DIR}


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=HEADERS, method=method)
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read())


def prompt(session_id, text):
    msg = req("POST", f"/session/{session_id}/message", {
        "parts": [{"type": "text", "text": text}],
    })
    text_out, tools = [], []
    for p in msg.get("parts", []):
        if p.get("type") == "text":
            text_out.append(p["text"])
        elif p.get("type") == "tool":
            tools.append(p.get("tool"))
    return "\n".join(text_out), tools


# Session A：装配 + 用技能
sid_a = req("POST", "/session", {})["id"]
print(f"[A] session {sid_a}")
text_a, tools_a = prompt(sid_a, "帮我查一下上海的天气")
print(f"[A] tools: {tools_a}")
print(f"[A] reply: {text_a[:120]}")

# Session B：同实例新 session，未装配过任何技能
sid_b = req("POST", "/session", {})["id"]
print(f"\n[B] session {sid_b}")
text_b, tools_b = prompt(sid_b, "再次装配一次 weather 技能，然后列出你现在能用的所有工具名称，并查一下北京天气")
print(f"[B] tools: {tools_b}")
print(f"[B] reply: {text_b[:200]}")

# MCP 状态
print("\n[mcp status]", json.dumps(req("GET", "/mcp"), ensure_ascii=False))

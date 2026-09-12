# src/entry.py
# 漂流瓶网站的后端，跑在 Cloudflare Python Worker 上。
# 数据存在 Workers KV 里的一个 key（"bottles"）下面，
# 值是一个 JSON 数组，包含所有瓶子。
#
# 注意：Cloudflare 的 Python Worker 还在比较新的阶段，
# 如果部署后某些接口报奇怪的错，大概率是 JS <-> Python 之间
# 参数转换的细节问题，把报错截图发我，我再调整。

import json
import random
import string
import time
from urllib.parse import urlsplit, parse_qs
from js import Response

BOTTLES_KEY = "bottles"


def now_ms():
    return int(time.time() * 1000)


def gen_id():
    chars = string.ascii_lowercase + string.digits
    return "b_" + "".join(random.choice(chars) for _ in range(10))


async def load_bottles(env):
    raw = await env.BOTTLES.get(BOTTLES_KEY)
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []


async def save_bottles(env, bottles):
    await env.BOTTLES.put(BOTTLES_KEY, json.dumps(bottles))


def json_response(data, status=200):
    body = json.dumps(data)
    return Response.new(
        body,
        status=status,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
        },
    )


def error_response(message, status=400):
    return json_response({"error": message}, status=status)


async def on_fetch(request, env):
    url_str = str(request.url)
    parts = urlsplit(url_str)
    path = parts.path
    query = parse_qs(parts.query)
    method = str(request.method)

    try:
        # ---------- 扔瓶子 ----------
        if path == "/api/throw" and method == "POST":
            body = json.loads(await request.text())
            author_id = body.get("authorId")
            btype = body.get("type")
            content = body.get("content", "")
            if not author_id or btype not in ("text", "draw") or not content:
                return error_response("参数不完整")

            bottles = await load_bottles(env)
            bottle = {
                "id": gen_id(),
                "authorId": author_id,
                "type": btype,
                "content": content,
                "createdAt": now_ms(),
                "replies": [],
            }
            bottles.append(bottle)
            await save_bottles(env, bottles)
            return json_response({"ok": True, "bottle": bottle})

        # ---------- 打捞 ----------
        if path == "/api/fish" and method == "GET":
            author_id = (query.get("authorId") or [None])[0]
            bottles = await load_bottles(env)
            candidates = [b for b in bottles if b.get("authorId") != author_id]
            pool = candidates if candidates else bottles
            if not pool:
                return json_response({"bottle": None})
            return json_response({"bottle": random.choice(pool)})

        # ---------- 回复 ----------
        if path == "/api/reply" and method == "POST":
            body = json.loads(await request.text())
            author_id = body.get("authorId")
            bottle_id = body.get("bottleId")
            text = (body.get("text") or "").strip()
            if not author_id or not bottle_id or not text:
                return error_response("参数不完整")

            bottles = await load_bottles(env)
            target = next((b for b in bottles if b.get("id") == bottle_id), None)
            if not target:
                return error_response("瓶子不存在", 404)

            target.setdefault("replies", []).append(
                {"authorId": author_id, "text": text, "createdAt": now_ms()}
            )
            await save_bottles(env, bottles)
            return json_response({"ok": True, "bottle": target})

        # ---------- 我扔出的瓶子 ----------
        if path == "/api/mine" and method == "GET":
            author_id = (query.get("authorId") or [None])[0]
            bottles = await load_bottles(env)
            mine = [b for b in bottles if b.get("authorId") == author_id]
            mine.sort(key=lambda b: b.get("createdAt", 0), reverse=True)
            return json_response({"bottles": mine})

        # ---------- 查看单个瓶子 ----------
        if path.startswith("/api/bottle/") and method == "GET":
            bottle_id = path[len("/api/bottle/"):]
            bottles = await load_bottles(env)
            target = next((b for b in bottles if b.get("id") == bottle_id), None)
            return json_response({"bottle": target})

        # 其他路径（包括首页 index.html）交给静态资源处理
        return await env.ASSETS.fetch(request)

    except Exception as e:
        return error_response(str(e), 500)

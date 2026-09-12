// src/entry.js
// 漂流瓶网站的后端，跑在 Cloudflare Worker 上（JavaScript 版）。
// 数据存在 Workers KV 里的一个 key（"bottles"）下面，
// 值是一个 JSON 数组，包含所有瓶子。

const BOTTLES_KEY = "bottles";

function nowMs() {
  return Date.now();
}

function genId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "b_";
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function loadBottles(env) {
  const raw = await env.BOTTLES.get(BOTTLES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

async function saveBottles(env, bottles) {
  await env.BOTTLES.put(BOTTLES_KEY, JSON.stringify(bottles));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ---------- 扔瓶子 ----------
      if (path === "/api/throw" && method === "POST") {
        const body = await request.json();
        const authorId = body.authorId;
        const type = body.type;
        const content = body.content || "";
        if (!authorId || (type !== "text" && type !== "draw") || !content) {
          return errorResponse("参数不完整");
        }

        const bottles = await loadBottles(env);
        const bottle = {
          id: genId(),
          authorId,
          type,
          content,
          createdAt: nowMs(),
          replies: [],
        };
        bottles.push(bottle);
        await saveBottles(env, bottles);
        return jsonResponse({ ok: true, bottle });
      }

      // ---------- 打捞 ----------
      if (path === "/api/fish" && method === "GET") {
        const authorId = url.searchParams.get("authorId");
        const bottles = await loadBottles(env);
        const candidates = bottles.filter((b) => b.authorId !== authorId);
        const pool = candidates.length ? candidates : bottles;
        if (!pool.length) {
          return jsonResponse({ bottle: null });
        }
        const bottle = pool[Math.floor(Math.random() * pool.length)];
        return jsonResponse({ bottle });
      }

      // ---------- 回复 ----------
      if (path === "/api/reply" && method === "POST") {
        const body = await request.json();
        const authorId = body.authorId;
        const bottleId = body.bottleId;
        const text = (body.text || "").trim();
        if (!authorId || !bottleId || !text) {
          return errorResponse("参数不完整");
        }

        const bottles = await loadBottles(env);
        const target = bottles.find((b) => b.id === bottleId);
        if (!target) {
          return errorResponse("瓶子不存在", 404);
        }

        if (!target.replies) target.replies = [];
        target.replies.push({ authorId, text, createdAt: nowMs() });
        await saveBottles(env, bottles);
        return jsonResponse({ ok: true, bottle: target });
      }

      // ---------- 我扔出的瓶子 ----------
      if (path === "/api/mine" && method === "GET") {
        const authorId = url.searchParams.get("authorId");
        const bottles = await loadBottles(env);
        const mine = bottles
          .filter((b) => b.authorId === authorId)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return jsonResponse({ bottles: mine });
      }

      // ---------- 查看单个瓶子 ----------
      if (path.startsWith("/api/bottle/") && method === "GET") {
        const bottleId = path.slice("/api/bottle/".length);
        const bottles = await loadBottles(env);
        const target = bottles.find((b) => b.id === bottleId) || null;
        return jsonResponse({ bottle: target });
      }

      // 其他路径（包括首页 index.html）交给静态资源处理
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return errorResponse(String(e && e.message ? e.message : e), 500);
    }
  },
};

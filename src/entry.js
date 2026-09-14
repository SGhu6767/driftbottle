// src/entry.js
// 漂流瓶 Cloudflare Worker 后端

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

  if (!raw) {
    return [];
  }

  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function saveBottles(env, bottles) {
  await env.BOTTLES.put(
    BOTTLES_KEY,
    JSON.stringify(bottles)
  );
}

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    }
  );
}

function errorResponse(message, status = 400) {
  return jsonResponse(
    {
      ok: false,
      error: message
    },
    status
  );
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .slice(0, maxLength);
}

function validAuthorId(value) {
  if (typeof value !== "string") {
    return false;
  }

  return /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

function validImageData(value) {
  if (typeof value !== "string") {
    return false;
  }

  // 只接受 PNG/JPEG/WebP Data URL
  return /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(value);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {

      // ==============================
      // CORS 预检
      // ==============================

      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      }

      // ==============================
      // 扔漂流瓶
      // POST /api/throw
      // ==============================

      if (
        path === "/api/throw" &&
        method === "POST"
      ) {
        const body = await request.json();

        const authorId = body.authorId;
        const type = body.type;
        const content = body.content;

        if (!validAuthorId(authorId)) {
          return errorResponse(
            "作者 ID 无效",
            400
          );
        }

        if (
          type !== "text" &&
          type !== "draw"
        ) {
          return errorResponse(
            "只允许文字或画画",
            400
          );
        }

        if (type === "text") {

          const text = cleanText(
            content,
            500
          );

          if (!text) {
            return errorResponse(
              "漂流瓶内容不能为空",
              400
            );
          }

          const bottles =
            await loadBottles(env);

          const bottle = {
            id: genId(),
            authorId: authorId,
            type: "text",
            content: text,
            createdAt: nowMs(),
            replies: []
          };

          bottles.push(bottle);

          await saveBottles(
            env,
            bottles
          );

          return jsonResponse({
            ok: true,
            bottle
          });
        }

        // 画画
        if (!validImageData(content)) {
          return errorResponse(
            "图片格式无效",
            400
          );
        }

        // 防止超大的 Data URL
        if (content.length > 1500000) {
          return errorResponse(
            "图片太大，请缩小后再发送",
            413
          );
        }

        const bottles =
          await loadBottles(env);

        const bottle = {
          id: genId(),
          authorId: authorId,
          type: "draw",
          content: content,
          createdAt: nowMs(),
          replies: []
        };

        bottles.push(bottle);

        await saveBottles(
          env,
          bottles
        );

        return jsonResponse({
          ok: true,
          bottle
        });
      }

      // ==============================
      // 打捞漂流瓶
      // GET /api/fish?authorId=xxx
      // ==============================

      if (
        path === "/api/fish" &&
        method === "GET"
      ) {
        const authorId =
          url.searchParams.get("authorId") || "";

        const bottles =
          await loadBottles(env);

        if (!bottles.length) {
          return jsonResponse({
            bottle: null
          });
        }

        let pool =
          bottles.filter(
            bottle =>
              bottle.authorId !== authorId
          );

        // 如果没有别人的瓶子，
        // 就允许打捞自己的瓶子
        if (!pool.length) {
          pool = bottles;
        }

        const bottle =
          pool[
            Math.floor(
              Math.random() * pool.length
            )
          ];

        return jsonResponse({
          bottle
        });
      }

      // ==============================
      // 回复漂流瓶
      // POST /api/reply
      // ==============================

      if (
        path === "/api/reply" &&
        method === "POST"
      ) {
        const body =
          await request.json();

        const authorId =
          body.authorId;

        const bottleId =
          body.bottleId;

        const text =
          cleanText(
            body.text,
            500
          );

        if (!validAuthorId(authorId)) {
          return errorResponse(
            "作者 ID 无效"
          );
        }

        if (!bottleId) {
          return errorResponse(
            "缺少瓶子 ID"
          );
        }

        if (!text) {
          return errorResponse(
            "回复不能为空"
          );
        }

        const bottles =
          await loadBottles(env);

        const target =
          bottles.find(
            bottle =>
              bottle.id === bottleId
          );

        if (!target) {
          return errorResponse(
            "瓶子不存在",
            404
          );
        }

        if (!Array.isArray(target.replies)) {
          target.replies = [];
        }

        target.replies.push({
          authorId,
          text,
          createdAt: nowMs()
        });

        await saveBottles(
          env,
          bottles
        );

        return jsonResponse({
          ok: true,
          bottle: target
        });
      }

      // ==============================
      // 我的瓶子
      // GET /api/mine?authorId=xxx
      // ==============================

      if (
        path === "/api/mine" &&
        method === "GET"
      ) {
        const authorId =
          url.searchParams.get("authorId");

        if (!validAuthorId(authorId)) {
          return errorResponse(
            "缺少作者 ID"
          );
        }

        const bottles =
          await loadBottles(env);

        const mine =
          bottles
            .filter(
              bottle =>
                bottle.authorId === authorId
            )
            .sort(
              (a, b) =>
                (b.createdAt || 0) -
                (a.createdAt || 0)
            );

        return jsonResponse({
          bottles: mine
        });
      }

      // ==============================
      // 查看单个瓶子
      // GET /api/bottle/:id
      // ==============================

      if (
        path.startsWith("/api/bottle/") &&
        method === "GET"
      ) {
        const bottleId =
          decodeURIComponent(
            path.slice(
              "/api/bottle/".length
            )
          );

        const bottles =
          await loadBottles(env);

        const target =
          bottles.find(
            bottle =>
              bottle.id === bottleId
          ) || null;

        return jsonResponse({
          bottle: target
        });
      }

      // ==============================
      // 未知 API
      // ==============================

      if (path.startsWith("/api/")) {
        return errorResponse(
          "API 不存在",
          404
        );
      }

      // ==============================
      // 其他请求交给 Pages 静态资源
      // ==============================

      return await env.ASSETS.fetch(
        request
      );

    } catch (error) {

      console.error(error);

      return errorResponse(
        error &&
        error.message
          ? error.message
          : "服务器内部错误",
        500
      );
    }
  }
};

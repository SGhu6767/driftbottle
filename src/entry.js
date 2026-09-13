// src/entry.js
// 漂流瓶网站的后端，跑在 Cloudflare Worker 上。
// 数据存在 Workers KV 里的一个 key（"bottles"）下面。
// 值是一个 JSON 数组，包含所有瓶子。

const BOTTLES_KEY = "bottles";

// ==============================
// 基础工具
// ==============================

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
  await env.BOTTLES.put(
    BOTTLES_KEY,
    JSON.stringify(bottles)
  );
}

// ==============================
// JSON 响应
// ==============================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse(
    { error: message },
    status
  );
}

// ==============================
// Base64URL
// ==============================

function base64UrlEncode(data) {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  str = str
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (str.length % 4) {
    str += "=";
  }

  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// ==============================
// 管理员 Token
// ==============================

async function hmacSign(text, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text)
  );

  return base64UrlEncode(signature);
}

async function createAdminToken(secret) {
  const payload = {
    admin: true,
    exp: nowMs() + 12 * 60 * 60 * 1000
  };

  const payloadText = base64UrlEncode(
    JSON.stringify(payload)
  );

  const signature = await hmacSign(
    payloadText,
    secret
  );

  return `${payloadText}.${signature}`;
}

async function verifyAdminToken(token, secret) {
  try {
    if (!token || !secret) {
      return false;
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
      return false;
    }

    const payloadText = parts[0];
    const signature = parts[1];

    const expectedSignature = await hmacSign(
      payloadText,
      secret
    );

    if (signature !== expectedSignature) {
      return false;
    }

    const payloadBytes =
      base64UrlDecode(payloadText);

    const payload = JSON.parse(
      new TextDecoder().decode(payloadBytes)
    );

    if (!payload.admin) {
      return false;
    }

    if (!payload.exp || payload.exp < nowMs()) {
      return false;
    }

    return true;

  } catch (e) {
    return false;
  }
}

// ==============================
// 管理员密码验证
// ==============================

async function verifyAdminPassword(input, password) {
  if (!input || !password) {
    return false;
  }

  const a = await hmacSign(
    input,
    password
  );

  const b = await hmacSign(
    password,
    password
  );

  return a === b;
}

// ==============================
// 获取管理员 Token
// ==============================

function getBearerToken(request) {
  const header =
    request.headers.get("Authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice(7).trim();
}

async function requireAdmin(request, env) {
  const token = getBearerToken(request);

  if (!token) {
    return false;
  }

  return await verifyAdminToken(
    token,
    env.ADMIN_PASSWORD
  );
}

// ==============================
// Worker
// ==============================

export default {

  async fetch(request, env) {

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS OPTIONS
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization",
          "Access-Control-Allow-Methods":
            "GET, POST, DELETE, OPTIONS"
        }
      });
    }

    try {

      // =====================================================
      // 管理员登录
      // POST /api/admin/login
      // =====================================================

      if (
        path === "/api/admin/login" &&
        method === "POST"
      ) {

        if (!env.ADMIN_PASSWORD) {
          return errorResponse(
            "管理员密码尚未配置",
            500
          );
        }

        const body = await request.json();

        const password =
          body.password || "";

        const valid =
          await verifyAdminPassword(
            password,
            env.ADMIN_PASSWORD
          );

        if (!valid) {
          return errorResponse(
            "管理员密码错误",
            401
          );
        }

        const token =
          await createAdminToken(
            env.ADMIN_PASSWORD
          );

        return jsonResponse({
          ok: true,
          token,
          expiresIn: 12 * 60 * 60
        });
      }


      // =====================================================
      // 管理员：获取全部瓶子
      // GET /api/admin/bottles
      // =====================================================

      if (
        path === "/api/admin/bottles" &&
        method === "GET"
      ) {

        const isAdmin =
          await requireAdmin(
            request,
            env
          );

        if (!isAdmin) {
          return errorResponse(
            "没有管理员权限",
            401
          );
        }

        const bottles =
          await loadBottles(env);

        const sorted =
          [...bottles].sort(
            (a, b) =>
              (b.createdAt || 0) -
              (a.createdAt || 0)
          );

        return jsonResponse({
          ok: true,
          count: sorted.length,
          bottles: sorted
        });
      }


      // =====================================================
      // 管理员：删除瓶子
      // DELETE /api/admin/bottle/:id
      // =====================================================

      if (
        path.startsWith("/api/admin/bottle/") &&
        method === "DELETE"
      ) {

        const isAdmin =
          await requireAdmin(
            request,
            env
          );

        if (!isAdmin) {
          return errorResponse(
            "没有管理员权限",
            401
          );
        }

        const bottleId =
          path.slice(
            "/api/admin/bottle/".length
          );

        if (!bottleId) {
          return errorResponse(
            "缺少瓶子 ID"
          );
        }

        const bottles =
          await loadBottles(env);

        const index =
          bottles.findIndex(
            b => b.id === bottleId
          );

        if (index === -1) {
          return errorResponse(
            "瓶子不存在",
            404
          );
        }

        const deleted =
          bottles[index];

        bottles.splice(index, 1);

        await saveBottles(
          env,
          bottles
        );

        return jsonResponse({
          ok: true,
          message: "瓶子已删除",
          bottle: deleted,
          count: bottles.length
        });
      }


      // =====================================================
      // 扔瓶子
      // =====================================================

      if (
        path === "/api/throw" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const authorId =
          body.authorId;

        const type =
          body.type;

        const content =
          body.content || "";

        if (
          !authorId ||
          (type !== "text" &&
            type !== "draw") ||
          !content
        ) {
          return errorResponse(
            "参数不完整"
          );
        }

        const bottles =
          await loadBottles(env);

        const bottle = {
          id: genId(),
          authorId,
          type,
          content,
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


      // =====================================================
      // 打捞
      // =====================================================

      if (
        path === "/api/fish" &&
        method === "GET"
      ) {

        const authorId =
          url.searchParams.get(
            "authorId"
          );

        const bottles =
          await loadBottles(env);

        const candidates =
          bottles.filter(
            b => b.authorId !== authorId
          );

        const pool =
          candidates.length
            ? candidates
            : bottles;

        if (!pool.length) {
          return jsonResponse({
            bottle: null
          });
        }

        const bottle =
          pool[
            Math.floor(
              Math.random() *
              pool.length
            )
          ];

        return jsonResponse({
          bottle
        });
      }


      // =====================================================
      // 回复
      // =====================================================

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
          (body.text || "").trim();

        if (
          !authorId ||
          !bottleId ||
          !text
        ) {
          return errorResponse(
            "参数不完整"
          );
        }

        const bottles =
          await loadBottles(env);

        const target =
          bottles.find(
            b => b.id === bottleId
          );

        if (!target) {
          return errorResponse(
            "瓶子不存在",
            404
          );
        }

        if (!target.replies) {
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


      // =====================================================
      // 我扔出的瓶子
      // =====================================================

      if (
        path === "/api/mine" &&
        method === "GET"
      ) {

        const authorId =
          url.searchParams.get(
            "authorId"
          );

        const bottles =
          await loadBottles(env);

        const mine =
          bottles
            .filter(
              b => b.authorId === authorId
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


      // =====================================================
      // 查看单个瓶子
      // =====================================================

      if (
        path.startsWith(
          "/api/bottle/"
        ) &&
        method === "GET"
      ) {

        const bottleId =
          path.slice(
            "/api/bottle/".length
          );

        const bottles =
          await loadBottles(env);

        const target =
          bottles.find(
            b => b.id === bottleId
          ) || null;

        return jsonResponse({
          bottle: target
        });
      }


      // =====================================================
      // 静态网页
      // =====================================================

      return await env.ASSETS.fetch(
        request
      );

    } catch (e) {

      return errorResponse(
        String(
          e &&
          e.message
            ? e.message
            : e
        ),
        500
      );
    }
  }
};

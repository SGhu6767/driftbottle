// public/_worker.js
// 漂流瓶 Cloudflare Pages 后端
// API 与网页使用同一个 pages.dev 域名。

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
        "Cache-Control": "no-store",
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
      error: message
    },
    status
  );
}

function base64UrlEncode(bytes) {
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

async function hmacSign(secret, text) {
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

  return base64UrlEncode(
    new Uint8Array(signature)
  );
}

async function createAdminToken(secret) {
  const payload = {
    role: "admin",
    exp: Date.now() + 24 * 60 * 60 * 1000
  };

  const payloadText = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify(payload)
    )
  );

  const signature = await hmacSign(
    secret,
    payloadText
  );

  return payloadText + "." + signature;
}

async function verifyAdminToken(secret, token) {
  if (!secret || !token) {
    return false;
  }

  try {
    const parts = token.split(".");

    if (parts.length !== 2) {
      return false;
    }

    const payloadText = new TextDecoder().decode(
      base64UrlDecode(parts[0])
    );

    const payload = JSON.parse(payloadText);

    if (
      !payload ||
      payload.role !== "admin" ||
      typeof payload.exp !== "number" ||
      payload.exp < Date.now()
    ) {
      return false;
    }

    const expected = await hmacSign(
      secret,
      parts[0]
    );

    if (expected.length !== parts[1].length) {
      return false;
    }

    const a = new TextEncoder().encode(expected);
    const b = new TextEncoder().encode(parts[1]);

    let diff = 0;

    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }

    return diff === 0;
  } catch (e) {
    return false;
  }
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

async function requireAdmin(request, env) {
  const secret = env.ADMIN_PASSWORD;

  if (!secret) {
    return false;
  }

  const token = getBearerToken(request);

  return await verifyAdminToken(
    secret,
    token
  );
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ---------- OPTIONS ----------
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization"
      }
    });
  }

  // ---------- 管理员登录 ----------
  if (
    path === "/api/admin/login" &&
    method === "POST"
  ) {
    try {
      const body = await request.json();
      const password = String(
        body.password || ""
      );

      if (!env.ADMIN_PASSWORD) {
        return errorResponse(
          "管理员密码未配置",
          500
        );
      }

      if (
        password !== env.ADMIN_PASSWORD
      ) {
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
        token
      });
    } catch (e) {
      return errorResponse(
        "请求格式错误",
        400
      );
    }
  }

  // ---------- 管理员查看所有瓶子 ----------
  if (
    path === "/api/admin/bottles" &&
    method === "GET"
  ) {
    if (
      !(await requireAdmin(
        request,
        env
      ))
    ) {
      return errorResponse(
        "未授权",
        401
      );
    }

    const bottles =
      await loadBottles(env);

    bottles.sort(
      (a, b) =>
        (b.createdAt || 0) -
        (a.createdAt || 0)
    );

    return jsonResponse({
      bottles
    });
  }

  // ---------- 管理员删除瓶子 ----------
  if (
    path.startsWith(
      "/api/admin/bottle/"
    ) &&
    method === "DELETE"
  ) {
    if (
      !(await requireAdmin(
        request,
        env
      ))
    ) {
      return errorResponse(
        "未授权",
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

    bottles.splice(index, 1);

    await saveBottles(
      env,
      bottles
    );

    return jsonResponse({
      ok: true
    });
  }

  // ---------- 扔瓶子 ----------
  if (
    path === "/api/throw" &&
    method === "POST"
  ) {
    try {
      const body =
        await request.json();

      const authorId =
        String(body.authorId || "");

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

      // 文字限制
      if (type === "text") {
        if (
          typeof content !==
          "string"
        ) {
          return errorResponse(
            "文字格式错误"
          );
        }

        if (
          content.trim().length === 0
        ) {
          return errorResponse(
            "内容不能为空"
          );
        }

        if (
          content.length > 500
        ) {
          return errorResponse(
            "文字不能超过 500 字"
          );
        }
      }

      // 画画限制
      if (type === "draw") {
        if (
          typeof content !==
          "string"
        ) {
          return errorResponse(
            "图片格式错误"
          );
        }

        if (
          !content.startsWith(
            "data:image/png;base64,"
          )
        ) {
          return errorResponse(
            "只允许 PNG 图片"
          );
        }

        // Base64 大小限制
        if (
          content.length >
          7 * 1024 * 1024
        ) {
          return errorResponse(
            "图片不能超过约 5 MB"
          );
        }
      }

      const bottles =
        await loadBottles(env);

      const bottle = {
        id: genId(),
        authorId,
        type,
        content:
          type === "text"
            ? content.trim()
            : content,
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
    } catch (e) {
      return errorResponse(
        "服务器无法解析请求",
        400
      );
    }
  }

  // ---------- 打捞 ----------
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

  // ---------- 回复 ----------
  if (
    path === "/api/reply" &&
    method === "POST"
  ) {
    try {
      const body =
        await request.json();

      const authorId =
        String(body.authorId || "");

      const bottleId =
        String(body.bottleId || "");

      const text =
        String(body.text || "")
          .trim();

      if (
        !authorId ||
        !bottleId ||
        !text
      ) {
        return errorResponse(
          "参数不完整"
        );
      }

      if (text.length > 500) {
        return errorResponse(
          "回复不能超过 500 字"
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

      if (
        target.replies.length >= 50
      ) {
        return errorResponse(
          "这个瓶子的回复太多了"
        );
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
    } catch (e) {
      return errorResponse(
        "请求格式错误",
        400
      );
    }
  }

  // ---------- 我的瓶子 ----------
  if (
    path === "/api/mine" &&
    method === "GET"
  ) {
    const authorId =
      url.searchParams.get(
        "authorId"
      );

    if (!authorId) {
      return errorResponse(
        "缺少 authorId"
      );
    }

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

  // ---------- 查看单个瓶子 ----------
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

  // 未知 API
  return errorResponse(
    "接口不存在",
    404
  );
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    // 所有 API 都由 Pages Worker 处理
    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {
      try {
        return await handleApi(
          request,
          env
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

    // 其他请求交给 Pages 静态文件
    return env.ASSETS.fetch(
      request
    );
  }
};

/**
 * Cloudflare Pages Function: POST /api/floor/unlock
 * 楼层密码校验后端：校验通过返回带过期时间的 HMAC 签名 token，前端仅存 token。
 *
 * 环境变量（在 Cloudflare Pages 项目 Settings → Environment variables 配置，不进仓库）：
 *   FLOOR_PASSWORDS  JSON 字符串，如 {"2F":"sha256:8f43...","3F":"sha256:..."}
 *                    值为该层密码的 sha256 十六进制摘要（前缀 sha256:），明文仅建议临时使用
 *   UNLOCK_SECRET    token 签名密钥（任意长随机串）
 *
 * 请求：  POST  {"floor":"2F","password":"xxx"}
 * 成功：  200  {"token":"...","expires":1730000000000}
 * 失败：  401 密码错误 / 404 该楼层未配置密码（前端收到 404 会回退本地校验）
 */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC 签名 token：payload = floor.expires，防前端伪造 */
async function signToken(floor, expires, secret) {
  const payload = floor + "." + expires;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return btoa(payload) + "." + hex;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad request" }, 400); }

  const floor = String((body && body.floor) || "").trim();
  const pwd = String((body && body.password) || "");
  if (!floor || !pwd) return json({ error: "missing floor or password" }, 400);

  let table = {};
  try { table = JSON.parse(env.FLOOR_PASSWORDS || "{}"); } catch (e) { return json({ error: "server config error" }, 500); }

  const stored = table[floor];
  if (!stored) return json({ error: "floor not configured" }, 404);   // 前端收到 404 回退本地校验

  const ok = stored.indexOf("sha256:") === 0
    ? ("sha256:" + (await sha256Hex(pwd))) === stored
    : pwd === stored;
  if (!ok) return json({ error: "wrong password" }, 401);

  const expires = Date.now() + 2 * 60 * 60 * 1000;   // token 2 小时有效
  const token = await signToken(floor, expires, env.UNLOCK_SECRET || "hnu-floor-lock-dev-secret");
  return json({ token: token, expires: expires });
}

export async function onRequestGet() {
  return json({ error: "method not allowed" }, 405);
}

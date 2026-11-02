/**
 * Cloudflare Pages Function: GET /api/wq/bank
 * 前端同步共享题库：从 KV 读取 Worker 自主更新的题库，合并到前端 WQ_BANK
 *
 * 前置：在 Cloudflare Pages 项目设置中绑定 KV 命名空间 WQ_BANK_KV
 *   Pages → Settings → Functions → KV namespace bindings → 名称: WQ_BANK_KV
 */

function json(data, status) {
  var body;
  try { body = JSON.stringify(data); } catch (e) { body = '{"error":"json_stringify_failed"}'; }
  return new Response(body || "null", {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export async function onRequestGet(context) {
  try {
    var env = context.env || {};
    var KV = env.WQ_BANK_KV;
    if (!KV || typeof KV.get !== "function") {
      var keys = Object.keys(env);
      return json({
        error: "KV namespace WQ_BANK_KV not bound",
        hint: "在 Cloudflare Pages → Settings → Functions → KV namespace bindings 中绑定名称 WQ_BANK_KV",
        bound_env_keys: keys
      }, 500);
    }
    var raw = await KV.get("wq_bank_shared");
    var bank = raw ? JSON.parse(raw) : {};
    var metaRaw = await KV.get("wq_bank_meta");
    var meta = metaRaw ? JSON.parse(metaRaw) : null;
    return json({ bank: bank, meta: meta });
  } catch (e) {
    return json({ error: "read failed: " + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}

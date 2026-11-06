/**
 * Cloudflare Pages Function: GET /api/models
 * 诊断用：用服务端环境变量里的 TOKENHUB_API_KEY 查询当前 Key 可用的模型列表。
 * 不返回密钥本身。
 */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function onRequestGet(context) {
  var key = context.env && context.env.TOKENHUB_API_KEY;
  if (!key) return json({ error: "TOKENHUB_API_KEY 未配置" }, 500);
  try {
    var r = await fetch("https://tokenhub.tencentmaas.com/v1/models", {
      headers: { "Authorization": "Bearer " + key }
    });
    var data = await r.json();
    return json({ status: r.status, upstream: data }, r.status === 200 ? 200 : 502);
  } catch (e) {
    return json({ error: "models request failed: " + (e.message || String(e)) }, 502);
  }
}

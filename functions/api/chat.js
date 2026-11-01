/**
 * Cloudflare Pages Function: POST /api/chat
 * 前端 AI 请求代理：将请求转发到 Tencent TokenHub（OpenAI 兼容接口），
 * 规避浏览器 CORS 限制（Tencent API 不支持 OPTIONS 预检）。
 *
 * 请求体：{ endpoint, apiKey, model, messages }
 *   - endpoint:  目标 API 地址（仅允许白名单内的 Tencent TokenHub）
 *   - apiKey:    Bearer Token
 *   - model:     模型名（如 hy3）
 *   - messages:  OpenAI 格式消息数组
 *
 * 响应：透传 Tencent API 的 JSON 响应
 */

/* 允许的上游端点白名单，防止 SSRF */
var ALLOWED_ENDPOINTS = [
  "https://tokenhub.tencentmaas.com/v1/chat/completions"
];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function onRequestPost(context) {
  var request = context.request;

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad request: invalid JSON" }, 400);
  }

  var endpoint = body && body.endpoint;
  var apiKey = body && body.apiKey;
  var model = body && body.model;
  var messages = body && body.messages;

  if (!endpoint || !apiKey || !model || !Array.isArray(messages)) {
    return json({ error: "missing required fields: endpoint, apiKey, model, messages" }, 400);
  }

  /* 白名单校验 */
  if (ALLOWED_ENDPOINTS.indexOf(endpoint) === -1) {
    return json({ error: "endpoint not allowed" }, 403);
  }

  try {
    var upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({ model: model, messages: messages })
    });

    var data = await upstream.json();
    /* 透传上游状态码与响应体 */
    return json(data, upstream.status);
  } catch (e) {
    return json({ error: "upstream request failed: " + e.message }, 502);
  }
}

export async function onRequestGet() {
  return json({ error: "method not allowed" }, 405);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}

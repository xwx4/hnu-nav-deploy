/**
 * Cloudflare Pages Function: POST /api/chat
 * 前端 AI 请求代理：将请求转发到 Tencent TokenHub（OpenAI 兼容接口），
 * 规避浏览器 CORS 限制（Tencent API 不支持 OPTIONS 预检）。
 * 支持 stream:true 时透传 SSE 流式响应，实现秒级首字响应。
 *
 * 请求体：{ endpoint, apiKey, model, messages, stream? }
 */

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
  /* 密钥优先从环境变量读取（可用新 Key 覆盖浏览器 localStorage 里的旧 Key），避免把 Key 写进公开仓库被爬取盗刷 */
  var apiKey = (context.env && context.env.TOKENHUB_API_KEY) || (body && body.apiKey) || "";
  var model = body && body.model;
  var messages = body && body.messages;
  var stream = body && body.stream;
  var reasoningEffort = body && body.reasoning_effort;

  if (!endpoint || !model || !Array.isArray(messages)) {
    return json({ error: "missing required fields: endpoint, model, messages" }, 400);
  }

  /* apiKey 已在上方由 body.apiKey 或 env.TOKENHUB_API_KEY 解析；两者都没有才报错 */
  if (!apiKey) {
    return json({ error: "missing apiKey: 请在 Cloudflare Pages 环境变量中配置 TOKENHUB_API_KEY" }, 400);
  }

  if (ALLOWED_ENDPOINTS.indexOf(endpoint) === -1) {
    return json({ error: "endpoint not allowed" }, 403);
  }

  try {
    var reqBody = { model: model, messages: messages, stream: !!stream };
    if (reasoningEffort) reqBody.reasoning_effort = reasoningEffort;

    var upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify(reqBody)
    });

    if (stream) {
      /* 透传 SSE 流式响应 */
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive"
        }
      });
    }

    var data = await upstream.json();
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

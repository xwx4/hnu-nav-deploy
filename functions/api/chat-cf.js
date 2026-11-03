/**
 * Cloudflare Pages Function: POST /api/chat-cf
 * 前端 AI 请求降级端点：当 Tencent TokenHub 跨境超时时，改用 Cloudflare Workers AI 内网调用。
 * 请求体：{ model, messages }
 * 模型名需为 Cloudflare Workers AI 支持的模型，如 @cf/meta/llama-3.1-70b-instruct
 */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

/* 将前端传入的模型别名映射到 Cloudflare Workers AI 模型 ID */
function mapModel(model) {
  if (!model) return "@cf/meta/llama-3.1-70b-instruct";
  var m = String(model).toLowerCase();
  if (m.indexOf("flash") >= 0 || m.indexOf("glm-5.3") >= 0 || m.indexOf("hy3") >= 0) {
    return "@cf/meta/llama-3.1-8b-instruct";
  }
  if (m.indexOf("pro") >= 0 || m.indexOf("kimi") >= 0 || m.indexOf("deepseek-v4") >= 0) {
    return "@cf/meta/llama-3.1-70b-instruct";
  }
  return "@cf/meta/llama-3.1-70b-instruct";
}

export async function onRequestPost(context) {
  var request = context.request;
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad request" }, 400);
  }

  var model = body && body.model;
  var messages = body && body.messages;

  if (!Array.isArray(messages) || !messages.length) {
    return json({ error: "missing messages" }, 400);
  }

  var aiModel = mapModel(model);

  try {
    /* Cloudflare Workers AI 内网调用 */
    var resp = await context.env.AI.run(aiModel, {
      messages: messages,
      max_tokens: 4096
    });
    var text = resp && resp.response;
    if (!text) return json({ error: "empty response" }, 502);
    /* 返回 OpenAI 兼容格式 */
    return json({
      choices: [{ message: { content: text } }]
    });
  } catch (e) {
    return json({ error: "cf ai failed: " + (e.message || String(e)) }, 502);
  }
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

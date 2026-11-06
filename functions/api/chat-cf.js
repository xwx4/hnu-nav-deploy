/**
 * Cloudflare Pages Function: POST /api/chat-cf
 * 前端 AI 请求降级端点：当 Tencent TokenHub 不可用（如 402 余额不足 / 跨境超时）时，
 * 改用 Cloudflare Workers AI 内网调用，保证 AI 一定能出内容。
 *
 * 请求体：{ model, messages, stream? }
 * 说明：前端传入的是业务模型别名；这里统一映射到 Workers AI 当前可用的模型，
 *       并按顺序逐个尝试，任何一个可用即返回。
 */

var MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/qwen/qwq-32b",
  "@cf/deepseek-ai/deepseek-r1-distill-llama-70b",
  "@cf/mistralai/mistral-small-3.1-24b-instruct"
];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

/* 把 Workers AI 的 SSE（data: {"response":"..."}）转换成 OpenAI 兼容 SSE */
function toOpenAISse(rs) {
  var reader = rs.getReader();
  var decoder = new TextDecoder();
  var encoder = new TextEncoder();
  var out = new ReadableStream({
    async start(controller) {
      var buf = "";
      function emit(obj) {
        var ch = obj && obj.choices && obj.choices[0];
        var txt = (obj && obj.response) || (ch && ch.delta && ch.delta.content) || (ch && ch.message && ch.message.content) || "";
        if (txt) controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + "\n\n"));
      }
      function drain(final) {
        var parts = buf.split("\n");
        buf = final ? "" : parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var line = parts[i].trim();
          if (!line || line.indexOf("data:") !== 0) continue;
          var d = line.slice(5).trim();
          if (!d || d === "[DONE]") continue;
          try { emit(JSON.parse(d)); } catch (e) {}
        }
      }
      try {
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, { stream: true });
          drain(false);
        }
        drain(true);
      } catch (e) {}
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(out, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    }
  });
}

export async function onRequestPost(context) {
  var request = context.request;
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad request" }, 400);
  }

  var messages = body && body.messages;
  var stream = !!(body && body.stream);
  if (!Array.isArray(messages) || !messages.length) {
    return json({ error: "missing messages" }, 400);
  }
  if (!context.env || !context.env.AI) {
    return json({ error: "AI binding missing" }, 502);
  }

  var lastErr = "";

  /* 流式：任何一个模型能起流就立即返回 */
  if (stream) {
    for (var i = 0; i < MODELS.length; i++) {
      try {
        var rs = await context.env.AI.run(MODELS[i], { messages: messages, stream: true, max_tokens: 4096 });
        if (rs) return toOpenAISse(rs);
      } catch (e) {
        lastErr = e && (e.message || String(e));
      }
    }
    return json({ error: "all cf models failed: " + lastErr }, 502);
  }

  /* 非流式：逐个模型尝试，成功即返回 OpenAI 兼容结果 */
  for (var j = 0; j < MODELS.length; j++) {
    try {
      var resp = await context.env.AI.run(MODELS[j], { messages: messages, max_tokens: 4096 });
      var text = resp && (resp.response || (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content));
      if (text) return json({ choices: [{ message: { content: text } }], model: MODELS[j] });
    } catch (e) {
      lastErr = e && (e.message || String(e));
    }
  }
  return json({ error: "all cf models failed: " + lastErr }, 502);
}

export async function onRequestGet() {
  return json({ error: "method not allowed", models: MODELS }, 405);
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

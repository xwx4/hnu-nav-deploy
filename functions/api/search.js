/**
 * Cloudflare Pages Function: GET /api/search?q=...
 * 联网搜索代理：抓取 DuckDuckGo HTML 搜索结果，提取标题/链接/摘要，
 * 供前端 AI 在解答时新消息类题目时获取最新信息。
 *
 * 避免浏览器直接访问搜索引擎的 CORS 限制。
 */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

/* 从 DDG HTML 结果页中提取搜索结果（标题/链接/摘要） */
function parseDdgResults(html) {
  var results = [];
  try {
    /* DDG HTML 结果用 <div class="result"> 包裹，内含 <a class="result__a"> 和 <a class="result__snippet"> */
    var resultBlocks = html.match(/<div class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g) || [];
    for (var i = 0; i < resultBlocks.length && results.length < 8; i++) {
      var block = resultBlocks[i];
      /* 标题链接 */
      var aMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      var title = "";
      var url = "";
      if (aMatch) {
        url = aMatch[1].replace(/&amp;/g, "&");
        /* DDG 用 //duckduckgo.com/l/?uddg=... 做跳转，提取真实 URL */
        var uddg = url.match(/uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
        title = aMatch[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
      }
      if (!title) continue;
      /* 摘要 */
      var snipMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      var snippet = "";
      if (snipMatch) {
        snippet = snipMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
      }
      results.push({ title: title, url: url, snippet: snippet });
    }
  } catch (e) { /* 解析失败返回空 */ }
  return results;
}

export async function onRequestGet(context) {
  var url = new URL(context.request.url);
  var q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "missing query param q" }, 400);

  try {
    var searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
    var resp = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    if (!resp.ok) return json({ error: "search upstream failed: HTTP " + resp.status }, 502);

    var html = await resp.text();
    var results = parseDdgResults(html);

    /* 若 DDG HTML 解析为空，尝试 lite 版本作为兜底 */
    if (!results.length) {
      var liteUrl = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q);
      var liteResp = await fetch(liteUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9"
        }
      });
      if (liteResp.ok) {
        var liteHtml = await liteResp.text();
        var linkMatches = liteHtml.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g) || [];
        for (var j = 0; j < linkMatches.length && results.length < 8; j++) {
          var lm = linkMatches[j].match(/href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
          if (!lm) continue;
          var t = lm[2].replace(/<[^>]+>/g, "").trim();
          if (!t || t.length < 4) continue;
          var u = lm[1].replace(/&amp;/g, "&");
          var u2 = u.match(/uddg=([^&]+)/);
          if (u2) u = decodeURIComponent(u2[1]);
          if (u.indexOf("duckduckgo.com") >= 0) continue;
          results.push({ title: t, url: u, snippet: "" });
        }
      }
    }

    return json({ query: q, count: results.length, results: results });
  } catch (e) {
    return json({ error: "search failed: " + e.message, results: [] }, 502);
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

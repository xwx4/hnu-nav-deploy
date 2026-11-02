/**
 * HNU 错题本 - 题库自主更新 Worker
 *
 * 功能：
 *  1. Cron 每 2 小时触发，自主扩展题库（无需用户操作）
 *  2. AI 生成候选题目 → AI 权威性评分（权重筛选）→ 达标入库
 *  3. 按"缺乏内容"优先补充题量少的知识点
 *  4. 写入 Cloudflare KV，供前端同步
 *  5. 暴露 HTTP 接口：GET /bank（读取共享题库）、GET /bank/stats（统计）
 *
 * 权威性评分权重（与前端 WQ_AI_CONFIG.qualityWeights 一致）：
 *   AI权威真实(0.4) + 答案可验证(0.3) + 知识点相关(0.2) + 表述清晰(0.1)
 *
 * 部署：wrangler deploy （需在 wrangler.toml 中配置 KV 命名空间绑定 WQ_BANK_KV）
 */

/* ============ 配置 ============ */
const TENCENT_ENDPOINT = "https://tokenhub.tencentmaas.com/v1/chat/completions";
const API_KEY = "sk-bHsivwabq4VodIU1tXxAjWUOOEkrlA65UFoRSrJ7C2fWPPrW";

/* 模型路由：用 Cloudflare Workers AI（内网调用，避免跨境超时） */
const MODEL = {
  generate: "@cf/meta/llama-3.1-70b-instruct",      // 生成候选题（非推理模型，JSON 输出稳定）
  score:    "@cf/swiss-ai/apertus-v1.5-8b",           // 权威性评分（多语言，支持函数调用）
  analyze:  "@cf/swiss-ai/apertus-v1.5-8b"            // 学科/知识点分析
};

/* 入库阈值：综合评分 >= 此值才入库（高级题门槛） */
const STORE_THRESHOLD = 0.82;
/* 每次 Cron 最多入库题数 */
const MAX_STORE_PER_RUN = 12;
/* 每知识点最少题数（低于此值优先补充） */
const MIN_QUESTIONS_PER_KP = 2;
/* 去重相似度阈值 */
const DEDUP_SIM = 0.4;
/* 最低难度门槛：只收录 L7 及以上的高级难题 */
const MIN_DIFF = 7;

/* 学科 & 常见知识点种子（用于自主扩展时选题） */
const SUBJECT_SEEDS = {
  "数学": ["函数与导数", "三角函数", "数列", "立体几何", "解析几何", "概率统计", "不等式", "向量"],
  "物理": ["力学", "电磁学", "光学", "热学", "近代物理", "运动学", "能量守恒"],
  "化学": ["氧化还原", "化学平衡", "电化学", "有机化学", "元素周期律", "溶液离子"],
  "英语": ["阅读理解", "完形填空", "语法填空", "写作", "词汇辨析"],
  "语文": ["文言文", "现代文阅读", "作文", "诗歌鉴赏", "语言运用"],
  "生物": ["细胞", "遗传", "生态", "代谢", "调节"],
  "历史": ["中国古代史", "中国近现代史", "世界史", "史学常识"],
  "地理": ["自然地理", "人文地理", "区域地理", "地球地图"],
  "政治": ["经济生活", "政治生活", "文化生活", "生活与哲学"]
};

/* ============ 工具函数 ============ */
function textSim(a, b) {
  if (!a || !b) return 0;
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  if (a === b) return 1;
  var setA = new Set(), setB = new Set();
  for (var i = 0; i < a.length - 1; i++) setA.add(a.substr(i, 2));
  for (var j = 0; j < b.length - 1; j++) setB.add(b.substr(j, 2));
  var inter = 0;
  setA.forEach(function (c) { if (setB.has(c)) inter++; });
  return inter / Math.max(setA.size, setB.size, 1);
}

/* Cloudflare Workers AI 调用（内网，无跨境超时） */
async function callAI(messages, model, env) {
  var resp = await env.AI.run(model, { messages: messages, max_tokens: 8192 });
  var text = resp && resp.response;
  if (!text) throw new Error("AI empty response");
  return text;
}

/* 旧版外部 API 调用（保留备用，当前不使用） */
async function callAI_legacy(messages, model) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 90000); /* 90 秒超时，避免 CF 524 */
  try {
    var resp = await fetch(TENCENT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + API_KEY
      },
      body: JSON.stringify({ model: model, messages: messages }),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error("AI HTTP " + resp.status);
    var data = await resp.json();
    var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("AI empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* 从模型输出中提取 JSON（兼容 deepseek-r1 的 <think> 推理块与 markdown 代码围栏） */
function extractJSON(text) {
  if (!text) return null;
  /* 1. 去掉 deepseek-r1 等推理模型的 <think>...</think> 块 */
  var cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  /* 2. 优先从 markdown 代码围栏 ```json ... ``` 中提取 */
  var fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) {}
  }
  /* 3. 兜底：贪心匹配最外层 { } 或 [ ] */
  try {
    var m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) {}
  try {
    var m2 = cleaned.match(/\[[\s\S]*\]/);
    if (m2) return JSON.parse(m2[0]);
  } catch (e) {}
  return null;
}

/* ============ AI 生成候选题目（仅高级难题 L7-L10） ============ */
async function generateCandidates(subject, kp, count, env, log) {
  var sysPrompt = "你是一位" + subject + "资深命题专家，擅长命制高考压轴题、竞赛题与深度综合探究题。" +
    "请围绕知识点「" + kp + "」生成 " + count + " 道【高级难题】，严格要求：" +
    "①难度必须在 L7-L10 之间（L7=综合建模，L8=思想方法，L9=拓展探究，L10=原创研究），严禁出简单识记/直接套用题；" +
    "②题目真实可信、有深度、有区分度，最好基于高考真题/竞赛题改编或深度综合多个知识点；" +
    "③必须附标准答案与详细解析；" +
    "④若题目涉及时效性内容（如年份、政策、时事），请确保使用当前最新的真实数据，不得编造过时或错误信息。" +
    "严格按JSON数组返回：[{\"text\":\"题干\",\"answer\":\"答案\",\"solution\":\"解析\",\"diff\":7-10,\"source\":\"出题依据/来源说明\"}]";
  var messages = [
    { role: "system", content: sysPrompt },
    { role: "user", content: "知识点：" + kp + "\n学科：" + subject }
  ];
  var text = await callAI(messages, MODEL.generate, env);
  var arr = extractJSON(text);
  if (!Array.isArray(arr)) {
    if (log) {
      var preview = (text || "").replace(/[^a-zA-Z0-9\u4e00-\u9fa5\[\]\{\}\"\:\,\.\?\! ]/g, " ").substring(0, 200);
      log.push("  [debug] AI 响应长度 " + (text ? text.length : 0) + " 预览: " + preview);
    }
    return [];
  }
  var kept = arr.filter(function (q) {
    if (!q || !q.text || q.text.length < 10) return false;
    /* 过滤掉低难度题 */
    var d = parseInt(q.diff) || 0;
    return d >= MIN_DIFF;
  });
  if (kept.length === 0 && log) log.push("  [debug] 解析到 " + arr.length + " 道，过滤后剩 0 道（可能难度 < L7）");
  return kept;
}

/* ============ AI 权威性评分 ============ */
async function scoreQuestion(q, subject, kp, env) {
  var sysPrompt = "你是一位严谨的教研审核员。请对这道题的质量与权威性打分，严格按JSON返回：" +
    '{\"authority\":0-1,\"answerable\":0-1,\"relevant\":0-1,\"clarity\":0-1}' +
    "评分标准：authority=题目是否真实可信（非编造/非广告/非明显错误）；answerable=答案是否可验证且合理；relevant=是否与知识点「" + kp + "」匹配；clarity=题面表述是否清晰无歧义。";
  var qInfo = "学科：" + subject + "\n知识点：" + kp +
    "\n题干：" + q.text +
    "\n答案：" + (q.answer || "（无）") +
    "\n解析：" + (q.solution || "（无）") +
    "\n难度：L" + (q.diff || "?") +
    "\n来源：" + (q.source || "（未知）");
  var messages = [
    { role: "system", content: sysPrompt },
    { role: "user", content: qInfo }
  ];
  var text = await callAI(messages, MODEL.score, env);
  var result = extractJSON(text);
  if (!result) return { total: 0, breakdown: {} };
  var w = { ai: 0.4, answer: 0.3, source: 0.2, dedup: 0.1 };
  var total = (result.authority || 0) * w.ai +
              (result.answerable || 0) * w.answer +
              (result.relevant || 0) * w.source +
              (result.clarity || 0) * w.dedup;
  return { total: Math.min(1, total), breakdown: result };
}

/* ============ KV 读写 ============ */
async function loadBank(KV) {
  try {
    var raw = await KV.get("wq_bank_shared");
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) { return {}; }
}

async function saveBank(KV, bank) {
  await KV.put("wq_bank_shared", JSON.stringify(bank));
  await KV.put("wq_bank_meta", JSON.stringify({
    updated_at: new Date().toISOString(),
    total: countBank(bank)
  }));
}

/* 追加 Cron 运行记录到 wq_bank_cron_log（最多保留 50 条，供开发者监控） */
async function pushCronLog(KV, run) {
  try {
    var raw = await KV.get("wq_bank_cron_log");
    var arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(run);
    if (arr.length > 50) arr = arr.slice(0, 50);
    await KV.put("wq_bank_cron_log", JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

function countBank(bank) {
  var cnt = 0;
  for (var sub in bank) {
    for (var kp in bank[sub]) {
      cnt += (bank[sub][kp].questions || []).length;
    }
  }
  return cnt;
}

/* 找出题量不足的知识点（优先补充） */
function findLackingKps(bank) {
  var lacking = [];
  for (var sub in SUBJECT_SEEDS) {
    var kps = SUBJECT_SEEDS[sub];
    for (var i = 0; i < kps.length; i++) {
      var kp = kps[i];
      var node = bank[sub] && bank[sub][kp];
      var cnt = node ? (node.questions || []).length : 0;
      if (cnt < MIN_QUESTIONS_PER_KP) {
        lacking.push({ subject: sub, kp: kp, count: cnt });
      }
    }
  }
  /* 按题量从少到多排序 */
  lacking.sort(function (a, b) { return a.count - b.count; });
  return lacking;
}

/* 去重检查 */
function isDuplicate(bank, subject, kp, text) {
  var node = bank[subject] && bank[subject][kp];
  if (!node) return false;
  var existing = (node.questions || []);
  for (var i = 0; i < existing.length; i++) {
    if (textSim(text, existing[i].text) > DEDUP_SIM) return true;
  }
  return false;
}

/* ============ 主更新流程 ============ */
async function runUpdate(KV, env) {
  var log = [];
  var bank = await loadBank(KV);
  var lacking = findLackingKps(bank);
  log.push("题库现状：" + countBank(bank) + " 题，需补充知识点 " + lacking.length + " 个");

  if (lacking.length === 0) {
    log.push("所有知识点题量充足，跳过本次更新");
    await pushCronLog(KV, { time: new Date().toISOString(), stored: 0, attempted: 0, log: log });
    return log.join("\n");
  }

  var stored = 0, attempted = 0;
  /* 取前 3 个最缺的知识点，每个生成 3 道候选 */
  var targets = lacking.slice(0, 3);

  for (var ti = 0; ti < targets.length && stored < MAX_STORE_PER_RUN; ti++) {
    var t = targets[ti];
    log.push("补充「" + t.subject + " / " + t.kp + "」（当前 " + t.count + " 题）");

    try {
      var candidates = await generateCandidates(t.subject, t.kp, 3, env, log);
      log.push("  生成候选 " + candidates.length + " 道");

      for (var ci = 0; ci < candidates.length && stored < MAX_STORE_PER_RUN; ci++) {
        var q = candidates[ci];
        attempted++;

        /* 去重 */
        if (isDuplicate(bank, t.subject, t.kp, q.text)) {
          log.push("  候选" + (ci + 1) + " 重复，跳过");
          continue;
        }

        /* 难度门槛：只收录 L7 及以上高级难题 */
        var qDiff = Math.max(1, Math.min(10, parseInt(q.diff) || 0));
        if (qDiff < MIN_DIFF) {
          log.push("  候选" + (ci + 1) + " 难度 L" + qDiff + " < L" + MIN_DIFF + "，淘汰（仅收录高级难题）");
          continue;
        }

        /* AI 权威性评分 */
        var score = await scoreQuestion(q, t.subject, t.kp, env);
        if (score.total < STORE_THRESHOLD) {
          log.push("  候选" + (ci + 1) + " 评分 " + score.total.toFixed(2) + " < " + STORE_THRESHOLD + "，淘汰");
          continue;
        }

        /* 入库 */
        if (!bank[t.subject]) bank[t.subject] = {};
        if (!bank[t.subject][t.kp]) bank[t.subject][t.kp] = { mother: null, variants: [], questions: [] };
        bank[t.subject][t.kp].questions.push({
          text: q.text,
          answer: q.answer || "",
          idea: "",
          solution: q.solution || "",
          pitfall: "",
          method: "",
          diff: Math.max(1, Math.min(10, parseInt(q.diff) || 5)),
          kp: [t.kp],
          ability: [],
          source: "Worker自主-" + (q.source || "AI生成") + "-评分" + Math.round(score.total * 100),
          source_url: "",
          verify_status: "ai_passed",
          raw_text: q.text,
          added_at: new Date().toISOString(),
          ai_score: score.total,
          ai_breakdown: score.breakdown
        });
        stored++;
        log.push("  候选" + (ci + 1) + " 评分 " + score.total.toFixed(2) + "，✅ 入库");
      }
    } catch (e) {
      log.push("  处理异常：" + e.message);
    }
  }

  await saveBank(KV, bank);
  log.push("完成：尝试 " + attempted + " 道，新入库 " + stored + " 道，题库总计 " + countBank(bank) + " 题");
  await pushCronLog(KV, { time: new Date().toISOString(), stored: stored, attempted: attempted, log: log });
  return log.join("\n");
}

/* ============ Worker 入口 ============ */
export default {
  /* Cron 触发器：每 2 小时自主扩展题库 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async function () {
      try {
        await runUpdate(env.WQ_BANK_KV, env);
      } catch (e) {
        /* 即使出错也写入运行记录，便于排查 */
        try {
          await pushCronLog(env.WQ_BANK_KV, {
            time: new Date().toISOString(),
            stored: 0,
            attempted: 0,
            log: ["❌ 运行异常：" + (e && e.message ? e.message : String(e))]
          });
        } catch (_) { /* KV 写入也失败则忽略 */ }
      }
    })());
  },

  /* HTTP 接口：供前端读取共享题库 */
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;

    /* CORS 头 */
    var corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (path === "/bank" || path === "/api/bank") {
      var bank = await loadBank(env.WQ_BANK_KV);
      return new Response(JSON.stringify(bank), { headers: corsHeaders });
    }

    if (path === "/bank/stats" || path === "/api/bank/stats") {
      var b = await loadBank(env.WQ_BANK_KV);
      var meta = await env.WQ_BANK_KV.get("wq_bank_meta");
      var userLogRaw = await env.WQ_BANK_KV.get("wq_bank_log");
      var cronLogRaw = await env.WQ_BANK_KV.get("wq_bank_cron_log");
      return new Response(JSON.stringify({
        total: countBank(b),
        meta: meta ? JSON.parse(meta) : null,
        userSubmissions: userLogRaw ? JSON.parse(userLogRaw) : [],
        cronRuns: cronLogRaw ? JSON.parse(cronLogRaw) : []
      }), { headers: corsHeaders });
    }

    if (path === "/bank/run" || path === "/api/bank/run") {
      /* 手动触发更新（调试用） */
      var result = await runUpdate(env.WQ_BANK_KV, env);
      return new Response(JSON.stringify({ ok: true, result: result }), { headers: corsHeaders });
    }

    if (path === "/bank/test-ai") {
      /* 测试 AI 端点连通性和耗时 */
      var t0 = Date.now();
      try {
        var txt = await callAI([{ role: "user", content: "回复OK" }], MODEL.generate, env);
        return new Response(JSON.stringify({ ok: true, elapsedMs: Date.now() - t0, preview: txt.slice(0, 100) }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, elapsedMs: Date.now() - t0, error: e.message }), { headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ error: "not found", paths: ["/bank", "/bank/stats", "/bank/run"] }), {
      status: 404, headers: corsHeaders
    });
  }
};

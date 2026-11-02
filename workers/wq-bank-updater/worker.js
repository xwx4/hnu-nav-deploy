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

/* 模型路由：按任务选最合适的模型 */
const MODEL = {
  generate: "kimi-k3.1-pro",   // 生成候选题
  score:    "deepseek-v4.1-flash", // 权威性评分
  analyze:  "deepseek-v4.1-flash"  // 学科/知识点分析
};

/* 入库阈值：综合评分 >= 此值才入库 */
const STORE_THRESHOLD = 0.7;
/* 每次 Cron 最多入库题数 */
const MAX_STORE_PER_RUN = 12;
/* 每知识点最少题数（低于此值优先补充） */
const MIN_QUESTIONS_PER_KP = 2;
/* 去重相似度阈值 */
const DEDUP_SIM = 0.4;

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

async function callAI(messages, model) {
  var resp = await fetch(TENCENT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + API_KEY
    },
    body: JSON.stringify({ model: model, messages: messages })
  });
  if (!resp.ok) throw new Error("AI HTTP " + resp.status);
  var data = await resp.json();
  var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("AI empty response");
  return text;
}

function extractJSON(text) {
  try {
    var m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) {}
  try {
    var m2 = text.match(/\[[\s\S]*\]/);
    if (m2) return JSON.parse(m2[0]);
  } catch (e) {}
  return null;
}

/* ============ AI 生成候选题目 ============ */
async function generateCandidates(subject, kp, count) {
  var sysPrompt = "你是一位" + subject + "命题专家。请围绕知识点「" + kp + "】生成 " + count + " 道高质量题目。" +
    "要求：题目真实可信（非编造）、有标准答案与解析、难度分布合理（1-10级）。" +
    "严格按JSON数组返回：[{\"text\":\"题干\",\"answer\":\"答案\",\"solution\":\"解析\",\"diff\":1-10,\"source\":\"出题依据/来源说明\"}]";
  var messages = [
    { role: "system", content: sysPrompt },
    { role: "user", content: "知识点：" + kp + "\n学科：" + subject }
  ];
  var text = await callAI(messages, MODEL.generate);
  var arr = extractJSON(text);
  if (!Array.isArray(arr)) return [];
  return arr.filter(function (q) { return q && q.text && q.text.length >= 10; });
}

/* ============ AI 权威性评分 ============ */
async function scoreQuestion(q, subject, kp) {
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
  var text = await callAI(messages, MODEL.score);
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
async function runUpdate(KV) {
  var log = [];
  var bank = await loadBank(KV);
  var lacking = findLackingKps(bank);
  log.push("题库现状：" + countBank(bank) + " 题，需补充知识点 " + lacking.length + " 个");

  if (lacking.length === 0) {
    log.push("所有知识点题量充足，跳过本次更新");
    await KV.put("wq_bank_log", JSON.stringify({ time: new Date().toISOString(), log: log }));
    return log.join("\n");
  }

  var stored = 0, attempted = 0;
  /* 取前 3 个最缺的知识点，每个生成 3 道候选 */
  var targets = lacking.slice(0, 3);

  for (var ti = 0; ti < targets.length && stored < MAX_STORE_PER_RUN; ti++) {
    var t = targets[ti];
    log.push("补充「" + t.subject + " / " + t.kp + "」（当前 " + t.count + " 题）");

    try {
      var candidates = await generateCandidates(t.subject, t.kp, 3);
      log.push("  生成候选 " + candidates.length + " 道");

      for (var ci = 0; ci < candidates.length && stored < MAX_STORE_PER_RUN; ci++) {
        var q = candidates[ci];
        attempted++;

        /* 去重 */
        if (isDuplicate(bank, t.subject, t.kp, q.text)) {
          log.push("  候选" + (ci + 1) + " 重复，跳过");
          continue;
        }

        /* AI 权威性评分 */
        var score = await scoreQuestion(q, t.subject, t.kp);
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
  await KV.put("wq_bank_log", JSON.stringify({ time: new Date().toISOString(), log: log }));
  return log.join("\n");
}

/* ============ Worker 入口 ============ */
export default {
  /* Cron 触发器：每 2 小时自主扩展题库 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runUpdate(env.WQ_BANK_KV));
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
      var logRaw = await env.WQ_BANK_KV.get("wq_bank_log");
      return new Response(JSON.stringify({
        total: countBank(b),
        meta: meta ? JSON.parse(meta) : null,
        lastLog: logRaw ? JSON.parse(logRaw) : null
      }), { headers: corsHeaders });
    }

    if (path === "/bank/run" || path === "/api/bank/run") {
      /* 手动触发更新（调试用） */
      var result = await runUpdate(env.WQ_BANK_KV);
      return new Response(JSON.stringify({ ok: true, result: result }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "not found", paths: ["/bank", "/bank/stats", "/bank/run"] }), {
      status: 404, headers: corsHeaders
    });
  }
};

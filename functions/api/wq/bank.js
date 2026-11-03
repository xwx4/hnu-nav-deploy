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
    /* 开发者监控：用户上传日志 + Worker Cron 运行记录（兼容旧格式） */
    var userLogRaw = await KV.get("wq_bank_log");
    var cronLogRaw = await KV.get("wq_bank_cron_log");
    var userSubs = [];
    try { var p = userLogRaw ? JSON.parse(userLogRaw) : []; userSubs = Array.isArray(p) ? p : []; } catch (e) {}
    var cronRuns = [];
    try { var c = cronLogRaw ? JSON.parse(cronLogRaw) : []; cronRuns = Array.isArray(c) ? c : []; } catch (e) {}
    return json({
      bank: bank,
      meta: meta,
      userSubmissions: userSubs,
      cronRuns: cronRuns
    });
  } catch (e) {
    return json({ error: "read failed: " + (e && e.message ? e.message : String(e)) }, 500);
  }
}

/**
 * POST /api/wq/bank — 用户上传好题到共享题库
 * 前端已通过「程序评分 + AI权威性评分」双重检验，此处做服务端兜底校验：
 *   1. 题面、答案非空且长度合理
 *   2. 难度 1-10
 *   3. 含学科、知识点
 *   4. 去重（与共享题库已有题相似度 < 0.4）
 * 通过则写入 KV 的 wq_bank_shared，并记录到 wq_bank_log 供开发者审计。
 */
export async function onRequestPost(context) {
  try {
    var env = context.env || {};
    var KV = env.WQ_BANK_KV;
    if (!KV || typeof KV.get !== "function" || typeof KV.put !== "function") {
      return json({ error: "KV namespace WQ_BANK_KV not bound for write", bound_env_keys: Object.keys(env) }, 500);
    }
    var body;
    try { body = await context.request.json(); } catch (e) { return json({ error: "invalid JSON body" }, 400); }
    var q = body && body.question;
    if (!q || !q.text || !q.answer) return json({ error: "question.text and question.answer required" }, 400);
    /* 服务端兜底校验 */
    var text = String(q.text).trim();
    var answer = String(q.answer).trim();
    if (text.length < 8 || text.length > 2000) return json({ error: "题面长度需在 8-2000 字之间" }, 400);
    if (answer.length < 1 || answer.length > 800) return json({ error: "答案长度需在 1-800 字之间" }, 400);
    var diff = parseInt(q.diff) || 5;
    if (diff < 1 || diff > 10) return json({ error: "难度需在 1-10 之间" }, 400);
    var subject = String(q.subject || "其他").trim();
    var kp = String(q.kp || (q.kps && q.kps[0]) || "综合运用").trim();
    var score = parseFloat(q.score) || 0;
    /* 读取现有共享题库，去重 */
    var raw = await KV.get("wq_bank_shared");
    var bank = raw ? JSON.parse(raw) : {};
    if (!bank[subject]) bank[subject] = {};
    if (!bank[subject][kp]) bank[subject][kp] = { questions: [] };
    var node = bank[subject][kp];
    node.questions = node.questions || [];
    /* 跨知识点去重：扫描相同学科下所有知识点的题，避免同题因 KP 不同重复入库 */
    for (var dk in (bank[subject] || {})) {
      var dn = bank[subject][dk];
      for (var di = 0; di < (dn.questions || []).length; di++) {
        if (textSim(text, dn.questions[di].text) > 0.4) {
          return json({ ok: false, reason: "duplicate", msg: "题库中已有相似题目" });
        }
      }
    }
    /* 入库 */
    var record = {
      text: text, answer: answer, idea: q.idea || "", solution: q.solution || "",
      pitfall: q.pitfall || "", method: q.method || "", diff: diff,
      kp: q.kps || [kp], ability: q.ability || [],
      source: "用户贡献", score: score,
      added_at: new Date().toISOString()
    };
    node.questions.push(record);
    await KV.put("wq_bank_shared", JSON.stringify(bank));
    /* 记录开发者审计日志（兼容旧格式：旧 worker 曾写入 {time,log:[]} 对象） */
    var logRaw = await KV.get("wq_bank_log");
    var log = [];
    try {
      var parsed = logRaw ? JSON.parse(logRaw) : [];
      log = Array.isArray(parsed) ? parsed : [];
    } catch (e) { log = []; }
    log.unshift({
      at: new Date().toISOString(),
      action: "user_submit",
      subject: subject, kp: kp,
      text: text.slice(0, 100),
      score: score
    });
    if (log.length > 100) log = log.slice(0, 100);
    await KV.put("wq_bank_log", JSON.stringify(log));
    return json({ ok: true, msg: "已上传到共享题库" });
  } catch (e) {
    return json({ error: "submit failed: " + (e && e.message ? e.message : String(e)) }, 500);
  }
}

/* 简单相似度（与前端 textSim 一致） */
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

/**
 * DELETE /api/wq/bank — 管理员删除共享题库中的题目
 * body: { subject, kp, text }
 * 从 KV 的 wq_bank_shared 中移除该题（精确匹配或相似度>0.95），
 * 确保所有用户同步后不再看到此题。
 */
export async function onRequestDelete(context) {
  try {
    var env = context.env || {};
    var KV = env.WQ_BANK_KV;
    if (!KV || typeof KV.get !== "function" || typeof KV.put !== "function") {
      return json({ error: "KV namespace WQ_BANK_KV not bound for delete", bound_env_keys: Object.keys(env) }, 500);
    }
    var body;
    try { body = await context.request.json(); } catch (e) { return json({ error: "invalid JSON body" }, 400); }
    var subject = String(body.subject || "").trim();
    var kp = String(body.kp || "").trim();
    var text = String(body.text || "").trim();
    if (!subject || !kp || !text) return json({ error: "subject, kp, text required" }, 400);

    var raw = await KV.get("wq_bank_shared");
    var bank = raw ? JSON.parse(raw) : {};
    if (!bank[subject] || !bank[subject][kp]) {
      return json({ ok: false, reason: "not_found" });
    }
    var node = bank[subject][kp];
    var before = (node.questions || []).length;
    node.questions = (node.questions || []).filter(function (q) {
      return q.text !== text && textSim(q.text, text) < 0.95;
    });
    var removed = before - node.questions.length;
    if (removed > 0) {
      await KV.put("wq_bank_shared", JSON.stringify(bank));
      /* 记录删除日志 */
      var logRaw = await KV.get("wq_bank_log");
      var log = [];
      try { var p = logRaw ? JSON.parse(logRaw) : []; log = Array.isArray(p) ? p : []; } catch (e) { log = []; }
      log.unshift({
        at: new Date().toISOString(),
        action: "admin_delete",
        subject: subject, kp: kp,
        text: text.slice(0, 100)
      });
      if (log.length > 100) log = log.slice(0, 100);
      await KV.put("wq_bank_log", JSON.stringify(log));
    }
    return json({ ok: removed > 0, removed: removed });
  } catch (e) {
    return json({ error: "delete failed: " + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}

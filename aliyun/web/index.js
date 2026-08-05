import { createServer } from "node:http";
import { Readable } from "node:stream";

// This function is deliberately tiny: GitHub Pages sends the photo here, and
// only this server-side process can see LUNA_API_KEY.  Never put that key in
// the public GitHub repository or a browser bundle.
const PORT = 9000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CONTEXT_LENGTH = 240;
const MAX_REQUESTS_PER_WINDOW = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RICE_KCAL_PER_BOWL = 174;
const RICE_KCAL_PER_100G = 116;
const ALLOWED_ORIGINS = new Set([
  "https://zkccz.github.io",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
  // Local file:// previews send the literal `null` Origin.
  "null",
]);
const recentRequests = new Map();

const SYSTEM_PROMPT = `你是“一口清楚”的中文食品图像与营养标签助手。用户可能拍到包装食品、饮料、包装背面的营养成分表，一碗菜、一盘饭、外卖、餐厅菜肴，水果或其他可食用食物。

先判断图像的主要内容和拍摄媒介是否符合要求。
- 如果整张图主要是手机/电脑屏幕、网页、App 界面、聊天记录、已有营养结果页或其他截图，即使截图里有食物缩略图，也必须返回 valid=false、input_kind="not_food"；不要把截图中的数字当成这次食物的营养数据。
- 如果清楚地不是食品、饮料、食品包装、营养标签或一份真实菜肴（例如人、宠物、风景、衣物、电子产品、家具、无关纸张），不要硬猜热量，返回 valid=false、input_kind="not_food" 和自然中文 rejection_message：“这似乎不是食品、饮料或一份菜肴，请重新拍一张食物、包装或营养成分表。”
- 只有当食物/饮料/包装/营养标签是照片中的真实主体时才返回 valid=true。直接拍一碗菜、一盘饭、水果或外卖都属于有效输入；即使无法精确估重，也要给出谨慎估算，并在 note 说明估算依据和不确定性。

对有效输入：
1. 结合图片和用户补充信息判断“每份”是多少克，以及用户这次一共吃了几份。包装标签若是每100g，请换算成每份；用户说“半袋、两份、整包、约一碗”等时，以用户实际摄入为准。
2. nutrition_per_serving 必须是单独“一份”的营养值；serving.count 和 intake.grams 代表用户本次的总摄入。能量优先给 kcal，包装写 kJ 时按 1 kcal = 4.184 kJ 换算。
3. 如果用户消息中出现“本次明确摄入量：N g”，这是最高优先级的确定输入，必须把 intake.grams 写成 N；不要用包装的每份克数、每100g基准或模型猜测覆盖它。包装/标签的每份克数仍写在 serving.grams。
4. 写 2 到 3 条简短、日常、非医疗化的营养评价。不要诊断疾病、不要声称治疗效果；不确定时要诚实说明。
5. 不要虚构品牌、包装规格或看不清的数值。看不清的营养字段可写 null。

只输出一个 JSON 对象，不要 Markdown、不要代码围栏。结构如下：
{
  "valid": true,
  "input_kind": "packaged_food | dish_or_meal | food_or_beverage | uncertain",
  "food_name": "中文食物名",
  "serving": {"label":"每份（约 65g）","grams":65,"count":1,"scope_label":"按本次 1 份（约65g）估算"},
  "intake": {"grams":65},
  "nutrition_per_serving": {"energy_kcal":300,"protein_g":8,"fat_g":10,"carbs_g":35,"sugar_g":null,"sodium_mg":200},
  "evaluations": ["...", "..."],
  "note": "估算或标签读取说明"
}`;

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("Unhandled analyze error", error);
    sendJson(req, res, 500, { error: "识别服务暂时不可用，请稍后再试" });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Nutrition API listening on ${PORT}`);
});

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    setCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/health") {
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname !== "/" && pathname !== "/api/analyze" && pathname !== "/analyze") {
    return sendJson(req, res, 404, { error: "Not found" });
  }
  if (!isAllowedOrigin(req)) {
    return sendJson(req, res, 403, { error: "来源不被允许" });
  }
  if (req.method !== "POST") {
    return sendJson(req, res, 405, { error: "只支持 POST 请求" });
  }
  if (!process.env.LUNA_API_KEY) {
    console.error("LUNA_API_KEY is missing");
    return sendJson(req, res, 503, { error: "识别服务尚未配置完成" });
  }
  if (!isWithinRateLimit(clientIp(req))) {
    return sendJson(req, res, 429, { error: "演示请求较多，请十分钟后再试" });
  }

  let form;
  try {
    form = await readFormData(req);
  } catch {
    return sendJson(req, res, 400, { error: "图片上传格式不正确，请重试" });
  }

  const image = form.get("image");
  const context = cleanText(form.get("context"), MAX_CONTEXT_LENGTH);
  const requestedIntakeGrams = clampNumber(form.get("intakeGrams"), 1, 20000, null) || parseExplicitIntakeGrams(context);
  if (!image || typeof image.arrayBuffer !== "function") {
    return sendJson(req, res, 400, { error: "请先选择一张图片" });
  }
  if (!isImageUpload(image)) {
    return sendJson(req, res, 415, { error: "请上传图片文件" });
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return sendJson(req, res, 413, { error: "图片请控制在 6MB 以内" });
  }

  let imageUrl;
  try {
    imageUrl = await fileToDataUrl(image);
  } catch {
    return sendJson(req, res, 400, { error: "图片处理失败，请换一张清晰照片" });
  }

  const payload = {
    model: process.env.LUNA_MODEL || "gpt-5.6-luna",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: context || requestedIntakeGrams
              ? `${context ? `用户补充：${context}` : "用户没有补充说明。"}${requestedIntakeGrams ? ` 用户在独立克数输入框明确填写：本次实际摄入 ${requestedIntakeGrams}g。此数值优先级最高。` : ""}`
              : "用户没有补充说明。请基于图片做谨慎判断；如果是菜肴，明确标注估算。",
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 1000,
    reasoning_effort: "none",
    response_format: { type: "json_object" },
  };

  let upstream;
  try {
    upstream = await requestLuna(payload);
  } catch (error) {
    console.error("Luna request failed", error instanceof Error ? error.message : String(error));
    return sendJson(req, res, 502, { error: "识别服务暂时不可用，请稍后再试" });
  }
  if (!upstream.ok) {
    console.error("Luna response error", upstream.status);
    return sendJson(req, res, 502, { error: "识别服务暂时不可用，请稍后再试" });
  }

  let modelJson;
  try {
    const responseBody = await upstream.json();
    modelJson = parseModelJson(responseBody?.choices?.[0]?.message?.content);
  } catch (error) {
    console.error("Luna response parse failed", error instanceof Error ? error.message : String(error));
    return sendJson(req, res, 502, { error: "识别结果格式异常，请换一张更清晰的图片" });
  }

  try {
    const output = normalizeModelOutput(modelJson, requestedIntakeGrams);
    if (!output.valid) return sendJson(req, res, 422, { error: output.rejectionMessage, code: "NOT_FOOD" });
    return sendJson(req, res, 200, { data: output.data });
  } catch (error) {
    console.error("Model normalization failed", error instanceof Error ? error.message : String(error));
    return sendJson(req, res, 502, { error: "识别结果格式异常，请换一张更清晰的图片" });
  }
}

async function readFormData(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  const request = new Request(`http://localhost${req.url || "/"}`, init);
  return request.formData();
}

async function requestLuna(payload) {
  const baseUrl = String(process.env.LUNA_BASE_URL || "https://xiaohondou.com/v1").replace(/\/$/, "");
  const makeRequest = (body) => fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LUNA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let response = await makeRequest(payload);
  if (response.status === 400 || response.status === 422) {
    const fallback = { ...payload };
    delete fallback.reasoning_effort;
    delete fallback.response_format;
    response = await makeRequest(fallback);
  }
  return response;
}

function normalizeModelOutput(raw, requestedIntakeGrams = null) {
  const kind = cleanText(raw?.input_kind, 48).toLowerCase();
  if (!raw || raw.valid === false || kind === "not_food") {
    return { valid: false, rejectionMessage: cleanText(raw?.rejection_message, 180) || "这似乎不是食品、饮料或一份菜肴，请重新拍一张食物、包装或营养成分表。" };
  }
  const sourceServing = asObject(raw.serving);
  const sourceIntake = asObject(raw.intake);
  const sourceNutrition = asObject(raw.nutrition_per_serving || raw.nutritionPerServing || raw.nutrition);
  const grams = clampNumber(firstPresent(sourceServing, ["grams", "gram", "weight_g", "weightGrams"]), 1, 2000, 100);
  const count = clampNumber(firstPresent(sourceServing, ["count", "servings", "quantity"]), 1, 100, 1);
  const modelIntakeGrams = clampNumber(
    firstPresent(sourceIntake, ["grams", "total_grams", "totalGrams", "intakeGrams", "intake_grams", "weightGrams", "weight_g"]) ?? firstPresent(raw, ["intakeGrams", "intake_grams", "totalGrams", "total_grams", "weightGrams", "weight_g"]),
    1,
    20000,
    grams * count,
  );
  const intakeGrams = clampNumber(requestedIntakeGrams, 1, 20000, modelIntakeGrams);
  const energyKcal = nullableNumber(firstPresent(sourceNutrition, ["energy_kcal", "energyKcal", "kcal", "calories"]));
  const energyKj = nullableNumber(firstPresent(sourceNutrition, ["energy_kj", "energyKj", "energyKJ"]));
  const normalizedKcal = energyKcal ?? (energyKj === null ? null : energyKj / 4.184);
  if (normalizedKcal === null || normalizedKcal < 0 || normalizedKcal > 5000) throw new Error("missing or invalid energy");

  const nutritionPerServing = {
    energyKcal: round(normalizedKcal, 0),
    protein: nullableNumber(firstPresent(sourceNutrition, ["protein_g", "proteinG", "protein"])),
    fat: nullableNumber(firstPresent(sourceNutrition, ["fat_g", "fatG", "fat"])),
    carbs: nullableNumber(firstPresent(sourceNutrition, ["carbs_g", "carbohydrate_g", "carbs", "carbohydrates", "carbohydrate"])),
    sugar: nullableNumber(firstPresent(sourceNutrition, ["sugar_g", "sugarG", "sugar", "sugars"])),
    sodium: nullableNumber(firstPresent(sourceNutrition, ["sodium_mg", "sodiumMg", "sodium"])),
  };
  for (const [key, value] of Object.entries(nutritionPerServing)) {
    if (key !== "energyKcal" && value !== null && (value < 0 || value > 10000)) nutritionPerServing[key] = null;
  }
  const totalKcal = nutritionPerServing.energyKcal * (intakeGrams / grams);
  const evaluations = normalizeEvaluations(raw.evaluations || raw.evaluation, nutritionPerServing, totalKcal);
  const servingLabel = cleanText(firstPresent(sourceServing, ["label", "name"]), 80) || `每份（约${round(grams, 0)}g）`;
  const scopeLabel = requestedIntakeGrams
    ? `按本次约 ${round(intakeGrams, 0)}g 估算`
    : cleanText(firstPresent(sourceServing, ["scope_label", "scopeLabel", "intake_label", "intakeLabel"]), 120) || `按本次约 ${round(intakeGrams, 0)}g 估算`;
  return {
    valid: true,
    data: {
      foodName: cleanText(raw.food_name || raw.foodName || raw.name, 80) || "这一顿",
      serving: { label: servingLabel, grams, count, scopeLabel, intakeGrams },
      nutritionPerServing,
      riceEquivalent: { bowls: round(totalKcal / RICE_KCAL_PER_BOWL, 1), grams: round(totalKcal / (RICE_KCAL_PER_100G / 100), 0), detail: "只按总能量粗略换算，不代表营养等价。" },
      evaluations,
      note: cleanText(raw.note, 300),
    },
  };
}

function normalizeEvaluations(source, nutrition, totalKcal) {
  const items = Array.isArray(source) ? source : typeof source === "string" ? source.split(/\n|；|;/) : [];
  const valid = items.map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 3);
  if (valid.length >= 2) return valid;
  const fallback = [`本次约 ${round(totalKcal, 0)} kcal，适合结合当天其余饮食一起看。`];
  if (nutrition.fat !== null && nutrition.fat >= 15) fallback.push("脂肪相对偏高，下一餐可搭配蔬菜和清淡蛋白质食物。");
  else if (nutrition.protein !== null && nutrition.protein >= 10) fallback.push("蛋白质不错，可搭配蔬菜或主食让这一餐更完整。");
  else fallback.push("营养数据来自图片估算或标签读取，建议按实际食用量理解。");
  if (nutrition.sodium !== null && nutrition.sodium >= 600) fallback.push("钠含量偏高，注意当天其他高盐食物。");
  return [...valid, ...fallback].slice(0, 3);
}

async function fileToDataUrl(file) {
  const buffer = await file.arrayBuffer();
  return `data:${inferImageMime(file)};base64,${Buffer.from(buffer).toString("base64")}`;
}

function parseModelJson(content) {
  if (typeof content !== "string") throw new Error("model content missing");
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.setHeader("Vary", "Origin");
  }
}

function sendJson(req, res, status, body) {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function isWithinRateLimit(ip) {
  const now = Date.now();
  const since = now - RATE_WINDOW_MS;
  const hits = (recentRequests.get(ip) || []).filter((time) => time >= since);
  if (hits.length >= MAX_REQUESTS_PER_WINDOW) return false;
  hits.push(now);
  recentRequests.set(ip, hits);
  if (recentRequests.size > 2000) {
    for (const [key, times] of recentRequests) if (!times.some((time) => time >= since)) recentRequests.delete(key);
  }
  return true;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isImageUpload(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "");
  return type.startsWith("image/") || /\.(?:jpe?g|png|webp|heic|heif)$/i.test(name);
}

function inferImageMime(file) {
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("image/")) return type;
  const name = String(file?.name || "").toLowerCase();
  if (/\.png$/.test(name)) return "image/png";
  if (/\.webp$/.test(name)) return "image/webp";
  if (/\.heic$/.test(name)) return "image/heic";
  if (/\.heif$/.test(name)) return "image/heif";
  return "image/jpeg";
}

function parseExplicitIntakeGrams(text) {
  const source = cleanText(text, MAX_CONTEXT_LENGTH);
  if (!source) return null;
  const fullPack = source.match(/(?:^|[，,。；;\s])我(?:这次)?\s*(?:吃了|吃掉了|食用了?)\s*整(?:袋|包)\s*(\d+(?:\.\d+)?)\s*(?:克|g)(?![A-Za-z0-9])/i);
  if (fullPack) return clampNumber(fullPack[1], 1, 20000, null);
  const patterns = [
    /(?:^|[，,。；;\s])(?:本次|这次|实际|食用量|摄入量)\s*(?:实际\s*)?(?:是|为|摄入了?|食用了?|吃了|吃掉了)?\s*(?:约|大约|差不多)?\s*(\d+(?:\.\d+)?)\s*(?:克|g)(?![A-Za-z0-9])/i,
    /(?:^|[，,。；;\s])我(?:这次)?\s*(?:本次|这次|实际)?\s*(?:吃了|吃掉了|食用了?|摄入了?|用了)?\s*(?:约|大约|差不多)?\s*(\d+(?:\.\d+)?)\s*(?:克|g)(?![A-Za-z0-9])/i,
    /(?:^|[，,。；;\s])(?:吃了|吃掉了|食用了?|摄入了?|用了)\s*(?:约|大约|差不多)?\s*(\d+(?:\.\d+)?)\s*(?:克|g)(?![A-Za-z0-9])/i,
  ];
  for (const pattern of patterns) {
    const explicit = source.match(pattern);
    if (explicit) return clampNumber(explicit[1], 1, 20000, null);
  }
  return /^\s*\d+(?:\.\d+)?\s*(?:克|g)\s*$/i.test(source) ? clampNumber(source, 1, 20000, null) : null;
}

function firstPresent(object, keys) {
  const source = asObject(object);
  for (const key of keys) if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  return undefined;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0]) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value, min, max, fallback) {
  const parsed = nullableNumber(value);
  return parsed === null ? fallback : Math.max(min, Math.min(max, parsed));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

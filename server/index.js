const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CONTEXT_LENGTH = 240;
const RICE_KCAL_PER_BOWL = 174;
const RICE_KCAL_PER_100G = 116;

const SYSTEM_PROMPT = `你是“一口清楚”的中文食品图像与营养标签助手。用户可能拍到：
- 包装食品、饮料、包装背面的营养成分表；
- 一碗菜、一盘饭、外卖、餐厅菜肴；
- 水果、零食或其他可食用食物。

先判断图像是否与食品、饮料、食品包装、营养标签或一份真实菜肴有关。
- 如果清楚地不是上述对象（例如人、宠物、风景、衣物、电子产品、家具、纯截图、无关纸张），不要硬猜热量，返回 valid=false、input_kind="not_food" 和自然中文 rejection_message："这似乎不是食品、饮料或一份菜肴，请重新拍一张食物、包装或营养成分表。"。
- 只要图中合理地存在食物、饮料、包装或菜肴，就应 valid=true；一碗菜或一盘饭属于有效输入，即使无法精确估重，也要给出谨慎估算，并在 note 说明估算依据和不确定性。

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/analyze") {
      return handleAnalyze(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleAnalyze(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, url) });
  }
  if (request.method !== "POST") {
    return json({ error: "只支持 POST 请求" }, 405, request, url);
  }
  if (!isAllowedOrigin(request, url)) {
    return json({ error: "来源不被允许" }, 403, request, url);
  }
  if (!env.LUNA_API_KEY) {
    console.error("LUNA_API_KEY is missing");
    return json({ error: "识别服务尚未配置完成" }, 503, request, url);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "图片上传格式不正确，请重试" }, 400, request, url);
  }

  const image = form.get("image");
  const context = cleanText(form.get("context"), MAX_CONTEXT_LENGTH);
  const requestedIntakeGrams = clampNumber(form.get("intakeGrams"), 1, 20000, null) || parseExplicitIntakeGrams(context);
  if (!image || typeof image.arrayBuffer !== "function") {
    return json({ error: "请先选择一张图片" }, 400, request, url);
  }
  if (!isImageUpload(image)) {
    return json({ error: "请上传图片文件" }, 415, request, url);
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return json({ error: "图片请控制在 6MB 以内" }, 413, request, url);
  }

  let imageUrl;
  try {
    imageUrl = await fileToDataUrl(image);
  } catch {
    return json({ error: "图片处理失败，请换一张清晰照片" }, 400, request, url);
  }

  const payload = {
    model: env.LUNA_MODEL || "gpt-5.6-luna",
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
    upstream = await requestLuna(payload, env);
  } catch (error) {
    console.error("Luna request failed", error instanceof Error ? error.message : String(error));
    return json({ error: "识别服务暂时不可用，请稍后再试" }, 502, request, url);
  }

  if (!upstream.ok) {
    console.error("Luna response error", upstream.status);
    return json({ error: "识别服务暂时不可用，请稍后再试" }, 502, request, url);
  }

  let modelJson;
  try {
    const responseBody = await upstream.json();
    const content = responseBody?.choices?.[0]?.message?.content;
    modelJson = parseModelJson(content);
  } catch (error) {
    console.error("Luna response parse failed", error instanceof Error ? error.message : String(error));
    return json({ error: "识别结果格式异常，请换一张更清晰的图片" }, 502, request, url);
  }

  const output = normalizeModelOutput(modelJson, requestedIntakeGrams);
  if (!output.valid) {
    return json({ error: output.rejectionMessage, code: "NOT_FOOD" }, 422, request, url);
  }
  return json({ data: output.data }, 200, request, url);
}

async function requestLuna(payload, env) {
  const endpoint = `${String(env.LUNA_BASE_URL || "https://xiaohondou.com/v1").replace(/\/$/, "")}/chat/completions`;
  const makeRequest = (body) => fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LUNA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let response = await makeRequest(payload);
  // Some OpenAI-compatible gateways do not support response_format or reasoning_effort.
  // Retry once without those optional controls while preserving the JSON instruction.
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
    return {
      valid: false,
      rejectionMessage: cleanText(raw?.rejection_message, 180)
        || "这似乎不是食品、饮料或一份菜肴，请重新拍一张食物、包装或营养成分表。",
    };
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

  if (normalizedKcal === null || normalizedKcal < 0 || normalizedKcal > 5000) {
    throw new Error("missing or invalid energy");
  }

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
    : cleanText(firstPresent(sourceServing, ["scope_label", "scopeLabel", "intake_label", "intakeLabel"]), 120)
      || `按本次约 ${round(intakeGrams, 0)}g 估算`;

  return {
    valid: true,
    data: {
      foodName: cleanText(raw.food_name || raw.foodName || raw.name, 80) || "这一顿",
      serving: { label: servingLabel, grams, count, scopeLabel, intakeGrams },
      nutritionPerServing,
      riceEquivalent: {
        bowls: round(totalKcal / RICE_KCAL_PER_BOWL, 1),
        grams: round(totalKcal / (RICE_KCAL_PER_100G / 100), 0),
        detail: "只按总能量粗略换算，不代表营养等价。",
      },
      evaluations,
      note: cleanText(raw.note, 300),
    },
  };
}

function normalizeEvaluations(source, nutrition, totalKcal) {
  const items = Array.isArray(source)
    ? source
    : typeof source === "string"
      ? source.split(/\n|；|;/)
      : [];
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
  return `data:${inferImageMime(file)};base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function parseModelJson(content) {
  if (typeof content !== "string") throw new Error("model content missing");
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
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
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return undefined;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0]) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value, min, max, fallback) {
  const parsed = nullableNumber(value);
  if (parsed === null) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isAllowedOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin || origin === "https://zkccz.github.io";
}

function corsHeaders(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedOrigin(request, url)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    Vary: "Origin",
  };
}

function json(body, status, request, url) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, url),
    },
  });
}

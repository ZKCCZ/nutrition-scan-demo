(function () {
  "use strict";

  // 前端只请求同源接口，任何模型密钥都应只存在于服务端环境变量中。
  // 接口约定：POST /api/analyze，multipart/form-data：image（图片）、context（用户补充说明）、intakeGrams（本次明确摄入量，可选）。
  // 推荐响应：
  // {
  //   foodName, serving: { label, grams, count, scopeLabel },
  //   nutritionPerServing: { energyKcal, protein, fat, carbs, sugar?, sodium },
  //   riceEquivalent: { bowls?, grams?, text?, detail? } // per-serving base; UI scales it once
  // }
  // Worker URL is public; the model key remains only in the Worker Secret.
  // The public page can switch proxies without rebuilding the app.  The
  // endpoint itself is not a secret; the model key must remain server-side.
  const API_PATH = String(window.NUTRI_API_ENDPOINT || "https://nutritican-demo-sqjzjsjfgi.cn-hangzhou.fcapp.run/api/analyze");
  const REQUEST_TIMEOUT_MS = 35000;
  const FALLBACK_DELAY_MS = 1200;
  const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
  const TARGET_UPLOAD_BYTES = 5.5 * 1024 * 1024;
  const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|heic|heif)$/i;

  const demoAnalysis = {
    foodName: "谷物脆片",
    serving: {
      label: "每份（65g）",
      grams: 65,
      count: 1,
      scopeLabel: "按本次 1 份（65g）估算",
    },
    nutritionPerServing: {
      energyKj: 1268,
      protein: 4.9,
      fat: 15.7,
      carbs: 39,
      sugar: 11.7,
      sodium: 293,
    },
    riceEquivalent: {
      bowls: 1.3,
      grams: 260,
      detail: "只按能量粗略换算，不代表营养等价。",
    },
    evaluations: [
      "能量适中，作为一份加餐更合适。",
      "脂肪相对偏高，正餐可搭配蔬菜和优质蛋白。",
      "钠含量中等，注意当天其他高盐食物。",
    ],
  };

  const $ = (id) => document.getElementById(id);
  const homeView = $("homeView");
  const contextView = $("contextView");
  const scanView = $("scanView");
  const resultView = $("resultView");
  const photoInput = $("photoInput");
  const contextPreview = $("contextPreview");
  const scanPreview = $("scanPreview");
  const resultPreview = $("resultPreview");
  const progressBar = $("progressBar");
  const progressTrack = document.querySelector(".progress-track");
  const scanStatus = $("scanStatus");
  const photoPickerButton = $("photoPickerButton");
  const amountInput = $("amountInput");
  const amountSlider = $("amountSlider");
  const toast = $("toast");

  let imageUrl = "";
  let previewObjectUrl = "";
  let selectedFile = null;
  let selectionIsDemo = false;
  let mealContext = "";
  let requestedIntakeGrams = null;
  let analyzedIntakeGrams = 65;
  let amount = 65;
  let maxAmount = 500;
  let serving = { ...demoAnalysis.serving };
  let nutrition = { ...demoAnalysis.nutritionPerServing };
  let riceEquivalent = { ...demoAnalysis.riceEquivalent };
  let evaluations = [...demoAnalysis.evaluations];
  let processingTimers = [];
  let activeController = null;
  let analysisRun = 0;
  let fileSelectionRun = 0;

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function number(value, fallback = 0) {
    if (typeof value === "string") {
      const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      value = match ? match[0] : value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    if (typeof value === "string") {
      const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      value = match ? match[0] : value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function clampIntakeGrams(value) {
    const parsed = optionalNumber(value);
    if (parsed === null || parsed < 1 || parsed > 20000) return null;
    return Math.round(parsed);
  }

  // Only infer a quantity from high-confidence wording.  A label such as
  // “每100g” or “整袋100g” describes the package, not necessarily what was
  // eaten this time, so it must not silently become the intake amount.
  function parseRequestedIntakeGrams(text) {
    const source = String(text || "").replace(/\s+/g, " ").trim();
    if (!source) return null;
    const fullPack = source.match(/(?:^|[，,。；;\s])我(?:这次)?\s*(?:吃了?|吃掉了?|食用了?|摄入了?)\s*(?:整|一)\s*(?:袋|包)\s*(?:约|大约|差不多)?\s*(\d+(?:\.\d+)?)\s*(?:克|g)(?:左右|上下)?(?![A-Za-z0-9])/i);
    if (fullPack) return clampIntakeGrams(fullPack[1]);
    const matches = [...source.matchAll(/(?:约|大约|差不多)?\s*(\d+(?:\.\d+)?)\s*(?:克|g)(?:左右|上下)?(?![A-Za-z0-9])/ig)];
    for (const match of matches) {
      const before = source.slice(0, match.index).replace(/[，,。；;：:\s]+$/g, "");
      const isPackageQuantity = /(?:每|每份|每袋|每包|包装|规格|含量|一袋|一包|整袋|整包)$/i.test(before);
      if (isPackageQuantity) continue;
      const hasIntakeCue = /(?:我(?:这次)?|本次|这次|实际|食用量|摄入量|吃|食用|摄入|用|半袋|半包)/i.test(before.slice(-24));
      const isStandalone = source.trim() === match[0].trim();
      if (hasIntakeCue || isStandalone) return clampIntakeGrams(match[1]);
    }
    return null;
  }

  async function detectImageMimeType(file) {
    const declaredType = String(file && file.type || "").toLowerCase();
    if (declaredType.startsWith("image/") && declaredType !== "image/*") return declaredType;
    const fileName = String(file && file.name || "");
    if (IMAGE_EXTENSIONS.test(fileName)) {
      if (/\.png$/i.test(fileName)) return "image/png";
      if (/\.webp$/i.test(fileName)) return "image/webp";
      if (/\.heic$/i.test(fileName)) return "image/heic";
      if (/\.heif$/i.test(fileName)) return "image/heif";
      return "image/jpeg";
    }
    // A few Android file managers hand the browser an image with no MIME type
    // or file extension. Sniff the short, non-sensitive header before
    // rejecting it, so a genuine Vivo camera image still reaches the preview.
    try {
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const has = (...values) => values.every((value, index) => head[index] === value);
      if (has(0xff, 0xd8, 0xff)) return "image/jpeg";
      if (has(0x89, 0x50, 0x4e, 0x47)) return "image/png";
      if (has(0x47, 0x49, 0x46, 0x38)) return "image/gif";
      if (has(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "image/webp";
      const brand = String.fromCharCode(...head.slice(8, 12));
      if (brand.includes("heic") || brand.includes("heix") || brand.includes("hevc") || brand.includes("hevx") || brand.includes("mif1")) return "image/heic";
    } catch (_) {
      // Fall through to the standard validation message below.
    }
    return "";
  }

  async function prepareImageFile(file) {
    if (!file || !file.size) throw new Error("没有读取到图片，请再选一次");
    const mimeType = await detectImageMimeType(file);
    if (!mimeType) throw new Error("请选择图片文件");
    const hasCorrectType = String(file.type || "").toLowerCase() === mimeType;
    const extension = mimeType === "image/png" ? "png"
      : mimeType === "image/webp" ? "webp"
        : mimeType === "image/gif" ? "gif"
          : mimeType === "image/heif" ? "heif"
            : mimeType === "image/heic" ? "heic" : "jpg";
    const baseName = String(file.name || "meal").replace(/\.[^.]+$/, "") || "meal";
    const normalized = hasCorrectType ? file : new File([file], `${baseName}.${extension}`, { type: mimeType, lastModified: Date.now() });
    return compressImageIfNeeded(normalized);
  }

  function loadImageElement(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = url;
    });
  }

  async function compressImageIfNeeded(file) {
    if (!file || file.size <= TARGET_UPLOAD_BYTES) return file;
    const sourceUrl = URL.createObjectURL(file);
    try {
      const image = await loadImageElement(sourceUrl);
      const maxDimension = 2200;
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
      canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("canvas unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let quality = 0.84;
      let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      while (blob && blob.size > TARGET_UPLOAD_BYTES && quality > 0.45) {
        quality -= 0.08;
        blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      }
      if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error("compression failed");
      const baseName = String(file.name || "meal").replace(/\.[^.]+$/, "") || "meal";
      return new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
    } catch (error) {
      if (file.size <= MAX_UPLOAD_BYTES) return file;
      throw new Error("这张照片太大，手机无法自动压缩，请换一张较小的图片");
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }

  function firstDefined(object, keys) {
    if (!isPlainObject(object)) return undefined;
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
    }
    return undefined;
  }

  function format(value, digits = 1) {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(value);
  }

  function formatInteger(value) {
    return Number.isFinite(value) ? Math.round(value).toLocaleString("zh-CN") : "—";
  }

  function delay(ms) {
    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      processingTimers.push(timer);
    });
  }

  function clearProcessing() {
    processingTimers.forEach((timer) => window.clearTimeout(timer));
    processingTimers = [];
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  }

  function showView(view) {
    [homeView, contextView, scanView, resultView].forEach((item) => item.classList.add("is-hidden"));
    view.classList.remove("is-hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function placeholderImage() {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="900" height="650" viewBox="0 0 900 650">
        <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#dceee3"/><stop offset="1" stop-color="#f2dfbe"/></linearGradient></defs>
        <rect width="900" height="650" fill="url(#g)"/><rect x="110" y="78" width="680" height="494" rx="28" fill="#fffdf8" transform="rotate(-3 450 325)"/>
        <text x="162" y="163" fill="#1f4f42" font-family="Arial, sans-serif" font-size="31" font-weight="700">营养成分表</text>
        <text x="162" y="201" fill="#687a70" font-family="Arial, sans-serif" font-size="17">Nutrition Information</text>
        <g fill="#26352f" font-family="Arial, sans-serif" font-size="22"><text x="162" y="270">项目</text><text x="480" y="270">每 100 克</text><text x="162" y="322">能量</text><text x="480" y="322">1950 kJ</text><text x="162" y="374">蛋白质</text><text x="480" y="374">7.5 g</text><text x="162" y="426">脂肪</text><text x="480" y="426">24.1 g</text><text x="162" y="478">碳水化合物</text><text x="480" y="478">60 g</text><text x="162" y="530">钠</text><text x="480" y="530">450 mg</text></g>
        <g stroke="#c5d3c9" stroke-width="3"><path d="M145 286h600M145 338h600M145 390h600M145 442h600M145 494h600M145 546h600"/></g>
      </svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  function revokePreviewUrl() {
    if (previewObjectUrl) {
      try { URL.revokeObjectURL(previewObjectUrl); } catch (_) { /* ignored */ }
      previewObjectUrl = "";
    }
  }

  function updateImage(url, ownsObjectUrl = false) {
    if (previewObjectUrl && previewObjectUrl !== url) revokePreviewUrl();
    imageUrl = url || placeholderImage();
    if (ownsObjectUrl) previewObjectUrl = imageUrl;
    contextPreview.src = imageUrl;
    scanPreview.src = imageUrl;
    resultPreview.src = imageUrl;
  }

  function enterContext({ url, file, isDemo, ownsObjectUrl = false }) {
    clearProcessing();
    analysisRun += 1;
    selectedFile = file || null;
    selectionIsDemo = Boolean(isDemo);
    mealContext = "";
    requestedIntakeGrams = null;
    $("mealContext").value = "";
    $("intakeGrams").value = "";
    $("contextPhotoBadge").textContent = selectionIsDemo ? "演示包装图" : "已选图片";
    updateImage(url, ownsObjectUrl);
    showView(contextView);
  }

  function resetToHome() {
    clearProcessing();
    analysisRun += 1;
    selectedFile = null;
    selectionIsDemo = false;
    mealContext = "";
    requestedIntakeGrams = null;
    photoInput.value = "";
    revokePreviewUrl();
    updateImage(placeholderImage());
    showView(homeView);
  }

  function resetBaseInputs() {
    $("baseEnergyInput").value = Number.isFinite(nutrition.energyKj) ? Math.round(nutrition.energyKj / 4.184) : "";
    $("baseProteinInput").value = Number.isFinite(nutrition.protein) ? nutrition.protein : "";
    $("baseFatInput").value = Number.isFinite(nutrition.fat) ? nutrition.fat : "";
    $("baseCarbsInput").value = Number.isFinite(nutrition.carbs) ? nutrition.carbs : "";
    $("baseSugarInput").value = Number.isFinite(nutrition.sugar) ? nutrition.sugar : "";
    $("baseSodiumInput").value = Number.isFinite(nutrition.sodium) ? nutrition.sodium : "";
  }

  function setResultText(id, value, unit, digits = 1) {
    $(id).textContent = Number.isFinite(value) ? `${format(value, digits)} ${unit}` : "—";
  }

  function setBaseText(id, value, unit, digits = 1) {
    $(id).textContent = Number.isFinite(value) ? `每份 ${format(value, digits)} ${unit}` : "标签未提供";
  }

  function renderEvaluations() {
    const list = $("evaluationList");
    list.replaceChildren();
    const safeItems = evaluations.filter((item) => typeof item === "string" && item.trim()).slice(0, 3);
    let items = safeItems.length ? safeItems : ["当前识别结果未给出评价，请先核对营养成分表。"];
    if (Math.round(amount) !== Math.round(analyzedIntakeGrams)) {
      items = [
        ...items.slice(0, 2),
        `已按 ${Math.round(amount)}g 实时重算营养数值；以上建议主要描述食物本身。`,
      ];
    }
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item.trim();
      list.appendChild(li);
    });
  }

  function renderRiceEquivalent(factor) {
    const baseBowls = optionalNumber(riceEquivalent.bowls);
    const baseGrams = optionalNumber(riceEquivalent.grams);
    const givenText = typeof riceEquivalent.text === "string" ? riceEquivalent.text.trim() : "";
    const detail = typeof riceEquivalent.detail === "string" && riceEquivalent.detail.trim()
      ? riceEquivalent.detail.trim()
      : "只按能量粗略换算，不代表营养等价。";

    if (baseBowls !== null) {
      $("riceEquivalent").textContent = `约 ${format(baseBowls * factor, 1)} 碗熟米饭`;
      $("riceEquivalentDetail").textContent = baseGrams !== null
        ? `约 ${formatInteger(baseGrams * factor)}g，${detail}`
        : detail;
      return;
    }
    $("riceEquivalent").textContent = givenText || "按能量约等于一份熟米饭";
    $("riceEquivalentDetail").textContent = detail;
  }

  function renderSliderScale() {
    const min = number(amountSlider.min, 1);
    const max = Math.max(min, number(amountSlider.max, 500));
    const scale = document.querySelector(".slider-scale");
    if (!scale) return;
    const ticks = [min, 100, 250, max]
      .filter((value, index, values) => value >= min && value <= max && values.indexOf(value) === index)
      .sort((left, right) => left - right);
    scale.replaceChildren();
    ticks.forEach((tick, index) => {
      const label = document.createElement("span");
      const ratio = max === min ? 0 : ((tick - min) / (max - min)) * 100;
      label.textContent = `${formatInteger(tick)}g`;
      if (index === 0) {
        label.style.left = "0";
        label.style.transform = "none";
      } else if (index === ticks.length - 1) {
        label.style.left = "100%";
        label.style.transform = "translateX(-100%)";
      } else {
        // Chrome Android positions a 16px range thumb within the usable
        // track, not at a percentage of the input's outside edges. Correct
        // the internal label by the same geometry so 100g sits under the
        // actual 100g thumb rather than a few pixels to its left.
        const thumbDiameter = 16;
        const correction = (thumbDiameter / 2) - ((ratio / 100) * thumbDiameter);
        label.style.left = `calc(${ratio}% + ${correction.toFixed(3)}px)`;
        label.style.transform = "translateX(-50%)";
      }
      scale.appendChild(label);
    });
  }

  function recalculate() {
    const requestedAmount = Math.max(1, number(amountInput.value, amount || serving.grams || 65));
    if (requestedAmount > maxAmount) {
      maxAmount = Math.max(500, Math.min(20000, Math.ceil(requestedAmount / 50) * 50));
      amountInput.max = String(maxAmount);
      amountSlider.max = String(maxAmount);
      renderSliderScale();
    }
    amount = Math.max(1, Math.min(maxAmount, requestedAmount));
    amountInput.value = Math.round(amount);
    amountSlider.value = Math.round(Math.min(amount, maxAmount));
    $("amountLabelTop").textContent = Math.round(amount);
    $("ringValue").textContent = `${Math.round(amount)}g`;

    const servingGrams = Math.max(1, number(serving.grams, 65));
    const factor = amount / servingGrams;
    const energyKj = Number.isFinite(nutrition.energyKj) ? nutrition.energyKj * factor : null;
    const calories = energyKj === null ? null : energyKj / 4.184;
    const result = {
      protein: Number.isFinite(nutrition.protein) ? nutrition.protein * factor : null,
      fat: Number.isFinite(nutrition.fat) ? nutrition.fat * factor : null,
      carbs: Number.isFinite(nutrition.carbs) ? nutrition.carbs * factor : null,
      sugar: Number.isFinite(nutrition.sugar) ? nutrition.sugar * factor : null,
      sodium: Number.isFinite(nutrition.sodium) ? nutrition.sodium * factor : null,
    };

    // Update each amount-dependent node directly. Rebuilding calorieDescription
    // with innerHTML used to replace #amountLabelTop during input events and
    // left the detail cards, rice conversion, and heading on the old amount in
    // some mobile browsers.
    const displayAmount = Math.round(amount);
    $("calorieValue").textContent = calories === null ? "—" : formatInteger(calories);
    $("calorieKjValue").textContent = formatInteger(calories);
    $("amountLabelTop").textContent = String(displayAmount);
    $("nutritionHeading").textContent = `${serving.label} → 本次 ${displayAmount}g`;
    $("unitNote").textContent = factor === 1 ? "正好 1 份" : `约 ${format(factor, 1)} 份`;

    $("energyKjResult").textContent = calories === null ? "—" : `${formatInteger(calories)} kcal`;
    setBaseText("energyKjBase", Number.isFinite(nutrition.energyKj) ? nutrition.energyKj / 4.184 : null, "kcal", 0);
    setResultText("proteinResult", result.protein, "g");
    setBaseText("proteinBase", nutrition.protein, "g");
    setResultText("fatResult", result.fat, "g");
    setBaseText("fatBase", nutrition.fat, "g");
    setResultText("carbsResult", result.carbs, "g");
    setBaseText("carbsBase", nutrition.carbs, "g");
    setResultText("sugarResult", result.sugar, "g");
    setBaseText("sugarBase", nutrition.sugar, "g");
    $("sodiumResult").textContent = result.sodium === null ? "—" : `${formatInteger(result.sodium)} mg`;
    setBaseText("sodiumBase", nutrition.sodium, "mg", 0);
    renderRiceEquivalent(factor);
    renderEvaluations();
  }

  function syncNutritionFromInputs() {
    const energyKcal = optionalNumber($("baseEnergyInput").value);
    nutrition.energyKj = energyKcal === null ? null : energyKcal * 4.184;
    nutrition.protein = optionalNumber($("baseProteinInput").value);
    nutrition.fat = optionalNumber($("baseFatInput").value);
    nutrition.carbs = optionalNumber($("baseCarbsInput").value);
    nutrition.sugar = optionalNumber($("baseSugarInput").value);
    nutrition.sodium = optionalNumber($("baseSodiumInput").value);
  }

  function normalizeAnalysis(payload, explicitIntakeGrams = null) {
    const raw = isPlainObject(payload && payload.data) ? payload.data : payload;
    if (!isPlainObject(raw)) throw new Error("识别服务返回的数据格式不正确");

    const rawServing = isPlainObject(raw.serving) ? raw.serving : (isPlainObject(raw.portion) ? raw.portion : {});
    const rawNutrition = raw.nutritionPerServing || raw.perServingNutrition || raw.nutrition_per_serving || raw.nutrition;
    if (!isPlainObject(rawNutrition)) throw new Error("识别结果缺少每份营养数据");

    const rawEnergyKj = firstDefined(rawNutrition, ["energyKj", "energyKJ", "energy_kj"]);
    const rawEnergyKcal = firstDefined(rawNutrition, ["energyKcal", "energyKcalorie", "energy_kcal", "calories", "kcal"]);
    const energyKj = optionalNumber(rawEnergyKj) ?? (optionalNumber(rawEnergyKcal) !== null ? optionalNumber(rawEnergyKcal) * 4.184 : null);
    if (energyKj === null) throw new Error("识别结果缺少能量数据");

    const grams = Math.max(1, number(
      firstDefined(rawServing, ["grams", "gram", "weightGrams", "weight"]) ?? firstDefined(raw, ["servingGrams", "perServingGrams", "portionGrams"]),
      65,
    ));
    const count = Math.max(1, number(
      firstDefined(rawServing, ["count", "servings", "quantity"]) ?? firstDefined(raw, ["servingCount", "servings", "quantity"]),
      1,
    ));
    const intake = isPlainObject(raw.intake) ? raw.intake : {};
    const modelIntakeGrams = Math.max(1, number(
      firstDefined(intake, ["grams", "totalGrams", "total_grams", "intakeGrams", "weightGrams", "weight_g"]) ?? firstDefined(raw, ["intakeGrams", "intake_grams", "totalGrams", "total_grams", "weightGrams", "weight_g"]),
      grams * count,
    ));
    const intakeGrams = clampIntakeGrams(explicitIntakeGrams) || modelIntakeGrams;
    const servingLabel = String(
      firstDefined(rawServing, ["label", "name"]) || raw.servingLabel || `每份（${formatInteger(grams)}g）`,
    );
    const scopeLabel = String(
      firstDefined(rawServing, ["scopeLabel", "intakeLabel"]) || firstDefined(intake, ["label", "scopeLabel"]) || raw.scopeLabel || `按本次约 ${formatInteger(intakeGrams)}g 估算`,
    );
    const sourceEvaluations = raw.evaluations || raw.evaluation || raw.assessment || raw.comments;
    const normalizedEvaluations = Array.isArray(sourceEvaluations)
      ? sourceEvaluations
      : typeof sourceEvaluations === "string"
        ? sourceEvaluations.split(/\n|；|;/)
        : [];

    return {
      foodName: String(raw.foodName || raw.name || raw.title || "这一顿"),
      serving: { label: servingLabel, grams, count, scopeLabel, intakeGrams },
      nutritionPerServing: {
        energyKj,
        protein: optionalNumber(firstDefined(rawNutrition, ["protein", "proteinG", "protein_g"])),
        fat: optionalNumber(firstDefined(rawNutrition, ["fat", "fatG", "fat_g", "lipid"])),
        carbs: optionalNumber(firstDefined(rawNutrition, ["carbs", "carbohydrates", "carbohydrate", "carbsG", "carbs_g"])),
        sugar: optionalNumber(firstDefined(rawNutrition, ["sugar", "sugars", "sugarG", "sugar_g"])),
        sodium: optionalNumber(firstDefined(rawNutrition, ["sodium", "sodiumMg", "sodium_mg"])),
      },
      riceEquivalent: isPlainObject(raw.riceEquivalent)
        ? raw.riceEquivalent
        : (isPlainObject(raw.rice_equivalent) ? raw.rice_equivalent : { text: raw.riceEquivalent || raw.rice_equivalent }),
      evaluations: normalizedEvaluations,
    };
  }

  function applyAnalysis(analysis, source, explicitIntakeGrams = null) {
    serving = { ...analysis.serving };
    const forcedIntakeGrams = clampIntakeGrams(explicitIntakeGrams);
    if (forcedIntakeGrams) {
      serving.intakeGrams = forcedIntakeGrams;
      serving.scopeLabel = `按本次约 ${formatInteger(forcedIntakeGrams)}g 估算`;
    }
    nutrition = { ...analysis.nutritionPerServing };
    riceEquivalent = isPlainObject(analysis.riceEquivalent) ? { ...analysis.riceEquivalent } : {};
    evaluations = Array.isArray(analysis.evaluations) ? [...analysis.evaluations] : [];
    analyzedIntakeGrams = Math.max(1, number(serving.intakeGrams, serving.grams));
    amount = analyzedIntakeGrams;
    maxAmount = Math.max(500, Math.min(20000, Math.ceil(amount / 50) * 50));
    amountInput.max = String(maxAmount);
    amountSlider.max = String(maxAmount);
    // Seed the editable controls before recalculate(). Otherwise that function
    // reads the old HTML value (for example the demo's 65g) and overwrites the
    // newly received or explicitly entered intake amount.
    amountInput.value = String(Math.round(amount));
    amountSlider.value = String(Math.round(Math.min(amount, maxAmount)));
    renderSliderScale();

    $("resultTitle").textContent = analysis.foodName;
    $("resultSubtitle").textContent = mealContext
      ? `${serving.scopeLabel} · 已参考你的补充信息`
      : serving.scopeLabel;
    $("calorieLabel").textContent = "本次摄入能量";
    $("resultSourceBadge").textContent = source === "live" ? "AI 识别 · 可核对" : "演示数据 · 可编辑";
    $("editDataTitle").textContent = `修改${serving.label}标签数据`;
    resetBaseInputs();
    recalculate();
  }

  function setProgress(value, text) {
    progressBar.style.width = `${value}%`;
    progressTrack.setAttribute("aria-valuenow", String(value));
    if (text) scanStatus.textContent = text;
  }

  function startProgress(isDemo) {
    $("scanKicker").textContent = isDemo ? "演示模式 · 本机生成结果" : "正在连接一口清楚";
    $("scanTitle").childNodes[0].textContent = "正在读取营养信息";
    $("previewBadge").textContent = isDemo ? "演示包装图" : "图片 + 补充说明";
    $("scanTipText").textContent = isDemo
      ? "这是可编辑的演示流程，不会调用识别服务。"
      : "正在把图片和你的补充信息整理成“每份”的营养估算。";
    setProgress(8, "先看看图片，再把数字整理成这一顿。");
    const stages = [
      [320, 30, "正在定位食物和营养成分表…"],
      [880, 61, "正在按你的食用量计算…"],
      [1560, 82, "正在生成米饭换算和营养评价…"],
    ];
    stages.forEach(([timeout, value, text]) => {
      const timer = window.setTimeout(() => setProgress(value, text), timeout);
      processingTimers.push(timer);
    });
  }

  async function requestAnalysis(file, context, intakeGrams = null) {
    if (!file) throw new Error("请先选择一张图片");
    const controller = new AbortController();
    activeController = controller;
    // Keep timeout aborts distinguishable from an intentional abort caused by
    // leaving the scan screen.  Previously an AbortError was silently ignored
    // by startAnalysis, so a slow/unreachable API left the UI on the scan view
    // forever.
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const formData = new FormData();
    formData.append("image", file, file.name || "meal.jpg");
    formData.append("context", context);
    const explicitIntakeGrams = clampIntakeGrams(intakeGrams);
    if (explicitIntakeGrams) formData.append("intakeGrams", String(explicitIntakeGrams));
    formData.append("locale", "zh-CN");

    try {
      const response = await fetch(API_PATH, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: formData,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = isPlainObject(payload) && typeof payload.error === "string" ? payload.error : `识别服务暂不可用（${response.status}）`;
        const error = new Error(message);
        error.code = isPlainObject(payload) ? payload.code : undefined;
        throw error;
      }
      return normalizeAnalysis(payload);
    } catch (error) {
      if (error && error.name === "AbortError" && timedOut) {
        const timeoutError = new Error("识别服务响应超时，请稍后再试");
        timeoutError.code = "TIMEOUT";
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
  }

  async function startAnalysis() {
    clearProcessing();
    const run = ++analysisRun;
    showView(scanView);
    startProgress(selectionIsDemo);
    const startedAt = Date.now();

    try {
      const analysis = selectionIsDemo
        ? (await delay(FALLBACK_DELAY_MS), normalizeAnalysis(demoAnalysis, requestedIntakeGrams))
        : await requestAnalysis(selectedFile, mealContext, requestedIntakeGrams);
      if (run !== analysisRun) return;
      setProgress(100, selectionIsDemo ? "演示结果已准备好" : "识别结果已准备好");
      await delay(230);
      if (run !== analysisRun) return;
      processingTimers = [];
      applyAnalysis(analysis, selectionIsDemo ? "demo" : "live", requestedIntakeGrams);
      showView(resultView);
    } catch (error) {
      // A stale run means the user cancelled/replaced the request; do not let
      // that old request update the new screen.  An AbortError from the active
      // run, however, is a real request failure (normally our timeout) and
      // must leave the scan screen instead of appearing to hang forever.
      if (run !== analysisRun) return;
      error = error instanceof Error ? error : new Error("识别服务暂不可用，请稍后再试");
      if (error && error.name === "AbortError") {
        error = new Error("识别服务请求被中断，请稍后再试");
        error.code = "ABORTED";
      }
      // Stop progress-stage timers before displaying the error; otherwise a
      // late stage timer can overwrite the failure message while we wait.
      clearProcessing();
      if (error.code === "NOT_FOOD") {
        $("scanKicker").textContent = "请重新拍一张";
        setProgress(100, error.message || "这似乎不是食品、饮料或一份菜肴。");
        $("scanTipText").textContent = "可以拍包装、营养成分表、饮料、水果，或一碗真实菜肴。";
        await delay(950);
        if (run !== analysisRun) return;
        processingTimers = [];
        showView(contextView);
        showToast(error.message || "这似乎不是食品、饮料或一份菜肴");
        return;
      }
      const remaining = Math.max(0, FALLBACK_DELAY_MS - (Date.now() - startedAt));
      $("scanKicker").textContent = "暂时无法连接识别服务";
      setProgress(93, error.message || "请稍后再试，或换一张更清晰的照片。");
      $("scanTipText").textContent = "图片没有被保存；你可以返回补充信息页后重新提交。";
      await delay(remaining + 650);
      if (run !== analysisRun) return;
      processingTimers = [];
      showView(contextView);
      showToast(error.message || "识别服务暂不可用，请稍后再试");
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2400);
  }

  photoPickerButton.addEventListener("click", () => {
    // This call remains directly inside the visible button's trusted click
    // gesture. It is more reliable in Android WebViews than a transparent
    // file input stretched over a styled element.
    try {
      if (typeof photoInput.showPicker === "function") {
        try {
          photoInput.showPicker();
          return;
        } catch (_) {
          // Older Android WebViews expose no supported picker API. The direct
          // click fallback below is still inside the same user gesture.
        }
      }
      photoInput.click();
    } catch (_) {
      showToast("无法打开相册，请在浏览器中重新打开页面后再试");
    }
  });

  photoInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const selection = ++fileSelectionRun;
    photoInput.value = "";
    try {
      const uploadFile = await prepareImageFile(file);
      if (selection !== fileSelectionRun) return;
      const url = URL.createObjectURL(uploadFile);
      enterContext({ url, file: uploadFile, isDemo: false, ownsObjectUrl: true });
    } catch (error) {
      if (selection !== fileSelectionRun) return;
      showToast(error instanceof Error ? error.message : "图片读取失败，请换一张试试");
    }
  });

  $("demoButton").addEventListener("click", () => enterContext({ url: placeholderImage(), file: null, isDemo: true }));
  $("backToHomeButton").addEventListener("click", resetToHome);
  $("mealContextForm").addEventListener("submit", (event) => {
    event.preventDefault();
    mealContext = $("mealContext").value.trim();
    const fieldIntake = clampIntakeGrams($("intakeGrams").value);
    const parsedContextIntake = parseRequestedIntakeGrams(mealContext);
    requestedIntakeGrams = fieldIntake || parsedContextIntake;
    if ($("intakeGrams").value && !fieldIntake) {
      showToast("克数请输入 1–20000 之间的数字");
      $("intakeGrams").focus();
      return;
    }
    startAnalysis();
  });
  $("cancelScanButton").addEventListener("click", () => {
    clearProcessing();
    analysisRun += 1;
    showView(contextView);
  });
  $("retakeTopButton").addEventListener("click", resetToHome);
  $("retakeButton").addEventListener("click", resetToHome);
  amountSlider.addEventListener("input", () => {
    amountInput.value = amountSlider.value;
    recalculate();
  });
  amountInput.addEventListener("input", recalculate);
  document.querySelectorAll("[data-step]").forEach((button) => button.addEventListener("click", () => {
    amountInput.value = Math.max(1, Math.min(maxAmount, Number(amountInput.value || amount || serving.grams) + Number(button.dataset.step)));
    recalculate();
  }));
  ["baseEnergyInput", "baseProteinInput", "baseFatInput", "baseCarbsInput", "baseSugarInput", "baseSodiumInput"].forEach((id) => $(id).addEventListener("input", () => {
    syncNutritionFromInputs();
    recalculate();
  }));
  $("saveButton").addEventListener("click", () => {
    const record = {
      savedAt: new Date().toISOString(),
      amount: Math.round(amount),
      serving: { ...serving },
      nutritionPerServing: { ...nutrition },
      mealContext,
    };
    try { window.localStorage.setItem("nutri-snap-last-record", JSON.stringify(record)); } catch (_) { /* 隐私模式下可能无法使用 localStorage */ }
    showToast("已保存到本机（演示）");
  });

  renderSliderScale();
  updateImage();
})();

(function () {
  "use strict";

  // 明天接入模型时，替换这个模拟识别函数的返回值即可；计算和展示逻辑保持不变。
  const demoNutrition = {
    name: "谷物脆片",
    basis: "每 100g",
    energyKj: 1950,
    protein: 7.5,
    fat: 24.1,
    carbs: 60,
    sugar: 18,
    sodium: 450,
  };

  const $ = (id) => document.getElementById(id);
  const homeView = $("homeView");
  const scanView = $("scanView");
  const resultView = $("resultView");
  const photoInput = $("photoInput");
  const scanPreview = $("scanPreview");
  const resultPreview = $("resultPreview");
  const progressBar = $("progressBar");
  const progressTrack = document.querySelector(".progress-track");
  const scanStatus = $("scanStatus");
  const amountInput = $("amountInput");
  const amountSlider = $("amountSlider");
  const toast = $("toast");
  let imageUrl = "";
  let amount = 65;
  let nutrition = { ...demoNutrition };
  let processingTimer;

  function showView(view) {
    [homeView, scanView, resultView].forEach((item) => item.classList.add("is-hidden"));
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

  function updateImage(url) {
    imageUrl = url || placeholderImage();
    scanPreview.src = imageUrl;
    resultPreview.src = imageUrl;
  }

  function startDemo(url) {
    window.clearTimeout(processingTimer);
    updateImage(url);
    showView(scanView);
    progressBar.style.width = "8%";
    progressTrack.setAttribute("aria-valuenow", "8");
    scanStatus.textContent = "先看看图片，再把数字整理成这一顿。";
    const stages = [
      [350, 30, "正在定位营养成分表…"],
      [760, 61, "正在整理能量和营养素…"],
      [1160, 86, "正在计算本次摄入…"],
      [1540, 100, "演示结果已准备好"],
    ];
    stages.forEach(([delay, progress, text]) => {
      window.setTimeout(() => {
        progressBar.style.width = `${progress}%`;
        progressTrack.setAttribute("aria-valuenow", String(progress));
        scanStatus.textContent = text;
      }, delay);
    });
    processingTimer = window.setTimeout(() => {
      nutrition = { ...demoNutrition };
      resetBaseInputs();
      showView(resultView);
      recalculate();
    }, 1750);
  }

  function resetBaseInputs() {
    $("baseEnergyInput").value = nutrition.energyKj;
    $("baseProteinInput").value = nutrition.protein;
    $("baseFatInput").value = nutrition.fat;
    $("baseCarbsInput").value = nutrition.carbs;
    $("baseSugarInput").value = nutrition.sugar;
    $("baseSodiumInput").value = nutrition.sodium;
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function format(value, digits = 1) {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
  }

  function syncNutritionFromInputs() {
    nutrition.energyKj = number($("baseEnergyInput").value, nutrition.energyKj);
    nutrition.protein = number($("baseProteinInput").value, nutrition.protein);
    nutrition.fat = number($("baseFatInput").value, nutrition.fat);
    nutrition.carbs = number($("baseCarbsInput").value, nutrition.carbs);
    nutrition.sugar = number($("baseSugarInput").value, nutrition.sugar);
    nutrition.sodium = number($("baseSodiumInput").value, nutrition.sodium);
  }

  function recalculate() {
    amount = Math.max(1, Math.min(500, number(amountInput.value, 65)));
    amountInput.value = Math.round(amount);
    amountSlider.value = Math.round(amount);
    $("amountLabelTop").textContent = Math.round(amount);
    $("ringValue").textContent = `${Math.round(amount)}g`;
    const factor = amount / 100;
    const kcal = nutrition.energyKj * factor / 4.184;
    const kj = nutrition.energyKj * factor;
    const result = {
      protein: nutrition.protein * factor,
      fat: nutrition.fat * factor,
      carbs: nutrition.carbs * factor,
      sugar: nutrition.sugar * factor,
      sodium: nutrition.sodium * factor,
    };
    $("calorieValue").textContent = Math.round(kcal).toLocaleString("zh-CN");
    $("calorieKjValue").textContent = Math.round(kj).toLocaleString("zh-CN");
    $("energyKjResult").textContent = `${Math.round(kj).toLocaleString("zh-CN")} kJ`;
    $("energyKjBase").textContent = `${Math.round(nutrition.energyKj).toLocaleString("zh-CN")} kJ / 100g`;
    $("proteinResult").textContent = `${format(result.protein)} g`;
    $("proteinBase").textContent = `${format(nutrition.protein)} g / 100g`;
    $("fatResult").textContent = `${format(result.fat)} g`;
    $("fatBase").textContent = `${format(nutrition.fat)} g / 100g`;
    $("carbsResult").textContent = `${format(result.carbs)} g`;
    $("carbsBase").textContent = `${format(nutrition.carbs)} g / 100g`;
    $("sugarResult").textContent = `${format(result.sugar)} g`;
    $("sugarBase").textContent = `${format(nutrition.sugar)} g / 100g`;
    $("sodiumResult").textContent = `${Math.round(result.sodium).toLocaleString("zh-CN")} mg`;
    $("sodiumBase").textContent = `${Math.round(nutrition.sodium).toLocaleString("zh-CN")} mg / 100g`;
    $("riceEquivalent").textContent = `${Math.round(kcal / 1.16)}g`;
    $("eggEquivalent").textContent = `${(kcal / 75).toFixed(1)}个`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2400);
  }

  photoInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("请选择图片文件");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => startDemo(String(reader.result));
    reader.readAsDataURL(file);
  });
  $("demoButton").addEventListener("click", () => startDemo());
  $("cancelScanButton").addEventListener("click", () => { window.clearTimeout(processingTimer); showView(homeView); });
  $("retakeTopButton").addEventListener("click", () => { showView(homeView); photoInput.value = ""; });
  $("retakeButton").addEventListener("click", () => { showView(homeView); photoInput.value = ""; });
  amountSlider.addEventListener("input", () => { amountInput.value = amountSlider.value; recalculate(); });
  amountInput.addEventListener("input", recalculate);
  document.querySelectorAll("[data-step]").forEach((button) => button.addEventListener("click", () => {
    amountInput.value = Math.max(1, Math.min(500, Number(amountInput.value || 65) + Number(button.dataset.step)));
    recalculate();
  }));
  ["baseEnergyInput", "baseProteinInput", "baseFatInput", "baseCarbsInput", "baseSugarInput", "baseSodiumInput"].forEach((id) => $(id).addEventListener("input", () => { syncNutritionFromInputs(); recalculate(); }));
  $("saveButton").addEventListener("click", () => {
    const record = { savedAt: new Date().toISOString(), amount: Math.round(amount), nutrition: { ...nutrition } };
    try { window.localStorage.setItem("nutri-snap-last-record", JSON.stringify(record)); } catch (_) { /* 隐私模式下可能无法使用 localStorage */ }
    showToast("已保存到本机（演示）");
  });

  updateImage();
})();

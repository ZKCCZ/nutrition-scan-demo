import nutritionWorker from "./worker-logic.js";

// Alibaba Function Compute's Node.js HTTP trigger gives us an event object.
// Convert it to Web Fetch Request so the exact same safe proxy logic used by
// the previous Worker can run here.  LUNA_API_KEY stays an FC environment
// variable and never reaches GitHub Pages.
export async function handler(event) {
  const input = typeof event === "string" ? JSON.parse(event) : event;
  const method = String(input.httpMethod || input.requestContext?.http?.method || "POST").toUpperCase();
  const path = String(input.rawPath || input.path || "/api/analyze");
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers || {})) {
    if (value !== undefined && value !== null) headers.set(key, String(value));
  }

  const requestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const body = input.body || "";
    requestInit.body = input.isBase64Encoded ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
  }
  const request = new Request(`https://fc-local${path.startsWith("/") ? path : `/${path}`}`, requestInit);
  const env = {
    LUNA_API_KEY: process.env.LUNA_API_KEY,
    LUNA_BASE_URL: process.env.LUNA_BASE_URL || "https://xiaohondou.com/v1",
    LUNA_MODEL: process.env.LUNA_MODEL || "gpt-5.6-luna",
  };

  let response;
  try {
    response = await nutritionWorker.fetch(request, env);
  } catch (error) {
    console.error("Nutrition proxy error", error);
    response = new Response(JSON.stringify({ error: "识别服务暂时不可用，请稍后再试" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
    isBase64Encoded: false,
  };
}

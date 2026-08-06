import { Readable } from "node:stream";
import { createServer } from "node:http";
import nutritionWorker from "./worker-logic.js";

// The existing Alibaba Cloud function is a custom-runtime HTTP function.
// Keep the public trigger stable while sharing the exact worker contract used
// in local tests and in the Cloudflare-compatible implementation.
const PORT = 9000;

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("Unhandled nutrition request", error);
    writeResponse(res, new Response(JSON.stringify({ error: "识别服务暂时不可用，请稍后再试" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Nutrition API listening on ${PORT}`);
});

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || "/", "http://fc-local");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }

  const requestInit = { method: req.method || "GET", headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    requestInit.body = Readable.toWeb(req);
    requestInit.duplex = "half";
  }

  const request = new Request(requestUrl, requestInit);
  const env = {
    LUNA_API_KEY: process.env.LUNA_API_KEY,
    LUNA_BASE_URL: process.env.LUNA_BASE_URL || "https://xiaohondou.com/v1",
    LUNA_MODEL: process.env.LUNA_MODEL || "gpt-5.6-luna",
    ASSETS: {
      fetch: async () => new Response("Not Found", { status: 404 }),
    },
  };
  const response = await nutritionWorker.fetch(request, env);
  writeResponse(res, response);
}

function writeResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  response.arrayBuffer().then((body) => res.end(Buffer.from(body))).catch(() => res.end());
}

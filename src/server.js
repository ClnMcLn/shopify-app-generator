import "dotenv/config";
import express from "express";
import http from "node:http";
import { generateShopifyApp } from "./lib/generateShopifyApp.js";

const required = ["SHOPIFY_EMAIL", "SHOPIFY_PASSWORD", "SHOPIFY_DEV_DASHBOARD_URL"];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// Give long-running Playwright requests plenty of time
app.use((req, res, next) => {
  // 10 minutes (adjust if you want)
  res.setTimeout(10 * 60 * 1000);
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/shopify/app-generator", async (req, res) => {
  const { brand_name, store_domain } = req.body || {};

  if (!brand_name || typeof brand_name !== "string") {
    return res.status(400).json({ error: "brand_name is required" });
  }

  if (!store_domain || typeof store_domain !== "string" || !store_domain.includes("myshopify.com")) {
    return res.status(400).json({ error: "store_domain must include myshopify.com" });
  }

  try {
    console.log(`[${new Date().toISOString()}] starting generateShopifyApp`, {
      brand_name,
      store_domain,
    });

const result = await generateShopifyApp({ brand_name, store_domain });

console.log(`[${new Date().toISOString()}] generateShopifyApp success`, {
  has_client_id: !!result?.client_id,
  has_client_secret: !!result?.client_secret,
  has_distribution_link: !!result?.distribution_link,
});

// “Envelope” makes Retool easier to bind to, while still returning the same top-level fields
return res.status(200).json({
  ok: true,
  result,
  ...result,
});
  } catch (err) {
    console.error("generateShopifyApp error:", err);
    return res.status(500).json({
      error: err?.message || "Unknown error",
      name: err?.name,
      // helpful when Retool shows you the JSON:
      ts: new Date().toISOString(),
    });
  }
});

const port = process.env.PORT || 3000;

// Use an explicit http server so we can raise server-side timeouts too
const server = http.createServer(app);

// 10 minutes (must exceed your longest run)
server.setTimeout(10 * 60 * 1000);
// Keep-alive tuning (helps some proxies)
server.keepAliveTimeout = 75 * 1000;
server.headersTimeout = 80 * 1000;

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
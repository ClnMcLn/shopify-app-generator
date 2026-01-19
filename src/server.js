import express from "express";
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
app.use(express.json());

// request logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, {
    bodyStub: req.body?.stub,
    bodyDryRun: req.body?.dry_run,
    envSTUB: process.env.STUB,
    envDRY_RUN: process.env.DRY_RUN,
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: "ping-should-exist-2026-01-18" });
});

app.get("/ping", (req, res) => {
  console.log("PING HIT", new Date().toISOString(), {
    STUB: process.env.STUB,
    DRY_RUN: process.env.DRY_RUN,
    retoolDebug: req.headers["x-retool-debug"],
  });

  res.json({
    ok: true,
    ts: Date.now(),
    env: {
      STUB: process.env.STUB,
      DRY_RUN: process.env.DRY_RUN,
    },
  });
});

app.post("/shopify/app-generator", async (req, res) => {
  const { brand_name, store_domain, stub, dry_run } = req.body || {};

  if (!brand_name || typeof brand_name !== "string") {
    return res.status(400).json({ error: "brand_name is required" });
  }

  if (!store_domain || typeof store_domain !== "string" || !store_domain.endsWith("myshopify.com")) {
    return res.status(400).json({ error: "store_domain must end in myshopify.com" });
  }

  try {
    const isTrue = (v) => String(v).toLowerCase() === "true";

    const resolvedStub =
      stub === true ||
      dry_run === true ||
      (stub !== false &&
        dry_run !== false &&
        (isTrue(process.env.STUB) || isTrue(process.env.DRY_RUN)));

    console.log("MODE RESOLVED:", { stub, dry_run, resolvedStub });

    if (resolvedStub) {
      return res.json({
        mode: "stub",
        app_name: `${brand_name} X Retention`,
        client_id: "stub_client_id",
        client_secret: "stub_client_secret",
        distribution_link: "stub_distribution_link",
      });
    }

    const result = await generateShopifyApp({ brand_name, store_domain });
    return res.json({ mode: "real", ...result });
  } catch (err) {
    console.error("generateShopifyApp error:", err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
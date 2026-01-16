import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/shopify/app-generator", async (req, res) => {
  const { brand_name, store_domain } = req.body || {};

  if (!brand_name || typeof brand_name !== "string") {
    return res.status(400).json({ error: "brand_name is required" });
  }

  if (
    !store_domain ||
    typeof store_domain !== "string" ||
    !store_domain.endsWith("myshopify.com")
  ) {
    return res
      .status(400)
      .json({ error: "store_domain must end in myshopify.com" });
  }

  // TEMP stub response so we can deploy end-to-end before adding Playwright.
  // Next step will replace this with the Playwright automation.
  return res.json({
    app_name: `${brand_name} X Retention`,
    client_id: "stub_client_id",
    client_secret: "stub_client_secret",
    distribution_link: "stub_distribution_link"
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

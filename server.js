import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM_ID = process.env.VERCEL_TEAM_ID || "";

if (!TOKEN) {
  console.error("❌ VERCEL_TOKEN missing in .env");
  process.exit(1);
}

// Helper: Vercel API call
async function vercel(path, options = {}) {
  const url = new URL(`https://api.vercel.com${path}`);
  if (TEAM_ID) url.searchParams.set("teamId", TEAM_ID);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Vercel API error ${res.status}`);
  }
  return data;
}

// Wrapper to catch errors
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

/* ---------------- PROJECTS ---------------- */
app.get("/api/projects", wrap(async (req, res) => {
  const data = await vercel("/v9/projects?limit=100");
  res.json(data.projects || []);
}));

app.post("/api/projects", wrap(async (req, res) => {
  const { name, framework } = req.body;
  const data = await vercel("/v11/projects", {
    method: "POST",
    body: JSON.stringify({ name, framework }),
  });
  res.json(data);
}));

app.delete("/api/projects/:id", wrap(async (req, res) => {
  const data = await vercel(`/v9/projects/${req.params.id}`, { method: "DELETE" });
  res.json(data);
}));

/* ---------------- DEPLOYMENTS ---------------- */
app.get("/api/deployments", wrap(async (req, res) => {
  const data = await vercel("/v6/deployments?limit=50");
  res.json(data.deployments || []);
}));

app.get("/api/deployments/:id", wrap(async (req, res) => {
  const data = await vercel(`/v13/deployments/${req.params.id}`);
  res.json(data);
}));

app.post("/api/deployments/:id/cancel", wrap(async (req, res) => {
  const data = await vercel(`/v12/deployments/${req.params.id}/cancel`, { method: "PATCH" });
  res.json(data);
}));

app.delete("/api/deployments/:id", wrap(async (req, res) => {
  const data = await vercel(`/v9/deployments/${req.params.id}`, { method: "DELETE" });
  res.json(data);
}));

app.get("/api/deployments/:id/logs", wrap(async (req, res) => {
  const data = await vercel(`/v2/deployments/${req.params.id}/events?limit=100`);
  res.json(data);
}));

// Redeploy: same git ref se naya deployment
app.post("/api/deployments/:id/redeploy", wrap(async (req, res) => {
  const dep = await vercel(`/v13/deployments/${req.params.id}`);
  const body = {
    name: dep.name,
    project: dep.project?.id,
    target: dep.target || "production",
    gitSource: dep.gitSource,
  };
  const data = await vercel("/v13/deployments", {
    method: "POST",
    body: JSON.stringify(body),
  });
  res.json(data);
}));

/* ---------------- ENV VARS ---------------- */
app.get("/api/projects/:id/env", wrap(async (req, res) => {
  const data = await vercel(`/v9/projects/${req.params.id}/env`);
  res.json(data.envs || []);
}));

app.post("/api/projects/:id/env", wrap(async (req, res) => {
  const { key, value, target } = req.body;
  const data = await vercel(`/v10/projects/${req.params.id}/env`, {
    method: "POST",
    body: JSON.stringify({
      key,
      value,
      type: "plain",
      target: target || ["production", "preview", "development"],
    }),
  });
  res.json(data);
}));

app.delete("/api/projects/:id/env/:envId", wrap(async (req, res) => {
  const data = await vercel(
    `/v9/projects/${req.params.id}/env/${req.params.envId}`,
    { method: "DELETE" }
  );
  res.json(data);
}));

/* ---------------- DOMAINS ---------------- */
app.get("/api/projects/:id/domains", wrap(async (req, res) => {
  const data = await vercel(`/v9/projects/${req.params.id}/domains`);
  res.json(data.domains || []);
}));

app.post("/api/projects/:id/domains", wrap(async (req, res) => {
  const { domain } = req.body;
  const data = await vercel(`/v10/projects/${req.params.id}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });
  res.json(data);
}));

app.delete("/api/projects/:id/domains/:domain", wrap(async (req, res) => {
  const data = await vercel(
    `/v9/projects/${req.params.id}/domains/${req.params.domain}`,
    { method: "DELETE" }
  );
  res.json(data);
}));

/* ---------------- USER INFO ---------------- */
app.get("/api/me", wrap(async (req, res) => {
  const data = await vercel("/v2/user");
  res.json(data.user || data);
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Running on http://localhost:${PORT}`));
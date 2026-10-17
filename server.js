import express from "express";
import session from "express-session";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

/* ---------------- CONFIG ---------------- */
const VTOKEN = process.env.VERCEL_TOKEN;
const TEAM_ID = process.env.VERCEL_TEAM_ID || "";
const GH_ID = process.env.GITHUB_CLIENT_ID || "";
const GH_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const GH_REDIRECT = process.env.GITHUB_REDIRECT_URI || "";
const BASIC_USER = process.env.BASIC_USER || "";
const BASIC_PASS = process.env.BASIC_PASS || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

if (!VTOKEN) {
  console.error("❌ VERCEL_TOKEN missing");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

/* ---------------- BASIC AUTH ---------------- */
function basicAuth(req, res, next) {
  if (!BASIC_USER || !BASIC_PASS) return next();
  if (req.path.startsWith("/auth/github/callback")) return next();

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [u, p] = Buffer.from(encoded, "base64").toString().split(":");
    if (u === BASIC_USER && p === BASIC_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Vercel Manager"');
  return res.status(401).send("Authentication required");
}
app.use(basicAuth);

/* ---------------- HELPERS ---------------- */
async function vercel(path, options = {}) {
  const url = new URL(`https://api.vercel.com${path}`);
  if (TEAM_ID) url.searchParams.set("teamId", TEAM_ID);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${VTOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Vercel API ${res.status}`);
  return data;
}

async function github(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "vercel-manager",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `GitHub API ${res.status}`);
  return data;
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

const requireGH = (req, res, next) => {
  if (!req.session.ghToken) return res.status(401).json({ error: "GitHub not connected" });
  next();
};

/* ============================================================
   GITHUB OAUTH
   ============================================================ */
app.get("/auth/github", (req, res) => {
  if (!GH_ID || !GH_SECRET) {
    return res.status(500).send("GitHub OAuth not configured. Set GITHUB_CLIENT_ID/SECRET.");
  }
  const params = new URLSearchParams({
    client_id: GH_ID,
    redirect_uri: GH_REDIRECT,
    scope: "repo read:user user:email",
    state: "vercel-manager",
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/auth/github/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect("/?gh=error");
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: GH_ID,
        client_secret: GH_SECRET,
        code,
        redirect_uri: GH_REDIRECT,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error("No access token");
    req.session.ghToken = tokenData.access_token;
    const user = await github("/user", tokenData.access_token);
    req.session.ghUser = user.login;
    res.redirect("/?gh=connected");
  } catch (e) {
    console.error("GitHub OAuth error:", e);
    res.redirect("/?gh=error");
  }
});

app.post("/auth/github/disconnect", (req, res) => {
  delete req.session.ghToken;
  delete req.session.ghUser;
  res.json({ ok: true });
});

app.get("/auth/github/status", (req, res) => {
  res.json({
    connected: !!req.session.ghToken,
    user: req.session.ghUser || null,
    oauthConfigured: !!(GH_ID && GH_SECRET),
  });
});

/* ---------------- GITHUB REPOS ---------------- */
app.get("/api/github/repos", requireGH, wrap(async (req, res) => {
  const repos = await github("/user/repos?per_page=100&sort=updated", req.session.ghToken);
  res.json(repos.map(r => ({
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    default_branch: r.default_branch,
    html_url: r.html_url,
    owner: r.owner.login,
  })));
}));

app.get("/api/github/repos/:owner/:repo/branches", requireGH, wrap(async (req, res) => {
  const { owner, repo } = req.params;
  const branches = await github(`/repos/${owner}/${repo}/branches?per_page=100`, req.session.ghToken);
  res.json(branches.map(b => ({ name: b.name, sha: b.commit.sha })));
}));

/* ============================================================
   PROJECTS
   ============================================================ */
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

/* ============================================================
   DEPLOY FROM GITHUB  ← FIXED
   ============================================================ */
app.post("/api/deploy/from-github", requireGH, wrap(async (req, res) => {
  const {
    projectName,
    framework,
    repoFullName,
    branch,
    rootDirectory,
    envVars,
    createProject,
  } = req.body;

  if (!projectName || !repoFullName || !branch) {
    return res.status(400).json({ error: "projectName, repoFullName, branch required" });
  }

  const [owner, repo] = repoFullName.split("/");

  // 1. GitHub se repo details fetch karo (numeric repoId ke liye)
  const ghRepo = await github(`/repos/${owner}/${repo}`, req.session.ghToken);
  const repoId = ghRepo.id;
  if (!repoId) throw new Error("Could not get GitHub repo ID");

  // 2. Ensure Vercel project exists (or create + link GitHub)
  let project;
  let isNewProject = false;
  try {
    project = await vercel(`/v9/projects/${encodeURIComponent(projectName)}`);
  } catch (e) {
    if (!createProject) {
      throw new Error("Project not found. Enable 'createProject' or create it first.");
    }
    project = await vercel("/v11/projects", {
      method: "POST",
      body: JSON.stringify({
        name: projectName,
        framework: framework || null,
        gitRepository: {
          type: "github",
          repo: repoFullName,
        },
      }),
    });
    isNewProject = true;
  }

  // 3. Deployment payload with gitSource + projectSettings
  const deployBody = {
    name: projectName,
    project: project.id,
    target: "production",
    gitSource: {
      type: "github",
      repoId,
      ref: branch,
    },
    projectSettings: {
      framework: framework || null,
      buildCommand: null,
      installCommand: null,
      outputDirectory: null,
      rootDirectory: rootDirectory || null,
    },
  };

  // New project ke liye auto-detection confirmation skip karo
  const deployPath = isNewProject
    ? "/v13/deployments?skipAutoDetectionConfirmation=1"
    : "/v13/deployments";

  const deployment = await vercel(deployPath, {
    method: "POST",
    body: JSON.stringify(deployBody),
  });

  // 4. Env vars add karo agar diye hain
  if (Array.isArray(envVars) && envVars.length) {
    for (const ev of envVars) {
      if (!ev.key || ev.value === undefined) continue;
      try {
        await vercel(`/v10/projects/${project.id}/env`, {
          method: "POST",
          body: JSON.stringify({
            key: ev.key,
            value: String(ev.value),
            type: "encrypted",
            target: ev.target || ["production", "preview", "development"],
          }),
        });
      } catch (e) {
        console.warn(`Env ${ev.key} failed:`, e.message);
      }
    }
  }

  res.json({
    ok: true,
    deploymentId: deployment.id,
    url: deployment.url,
    projectId: project.id,
  });
}));

/* ============================================================
   DEPLOYMENTS
   ============================================================ */
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

/* ============================================================
   ENV VARS
   ============================================================ */
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
      type: "encrypted",
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

/* ============================================================
   DOMAINS
   ============================================================ */
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

/* ---------------- USER ---------------- */
app.get("/api/me", wrap(async (req, res) => {
  const data = await vercel("/v2/user");
  res.json(data.user || data);
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
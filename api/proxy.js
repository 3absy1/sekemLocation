import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const ODOO_BASE_URL = "https://sekemportal.hooktrack.life";
const LOGIN_URL = `${ODOO_BASE_URL}/web/login`;
const CREATE_URL = `${ODOO_BASE_URL}/web/dataset/call_kw/per.diem/create`;
const sessionStore = new Map();

const app = express();
app.use(express.json({ limit: "10mb" })); // increase limit for image base64
app.use(cors());

function getCacheKey(email) {
  return email.trim().toLowerCase();
}

function extractSessionId(response) {
  const setCookies = response.headers.raw()["set-cookie"] || [];

  for (const cookie of setCookies) {
    const match = cookie.match(/session_id=([^;]+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function extractCsrfToken(html) {
  const match = html.match(/name="csrf_token"\s+value="([^"]+)"/i)
    || html.match(/name='csrf_token'\s+value='([^']+)'/i);

  return match?.[1] || null;
}

function isSessionExpired(response, text) {
  const location = response.headers.get("location") || "";
  const contentType = response.headers.get("content-type") || "";

  if (response.status === 401 || response.status === 403) {
    return true;
  }

  if (response.status >= 300 && response.status < 400 && location.includes("/web/login")) {
    return true;
  }

  if (contentType.includes("text/html") && text.includes("/web/login")) {
    return true;
  }

  try {
    const parsed = JSON.parse(text);
    const errorText = JSON.stringify(parsed.error || {}).toLowerCase();

    return errorText.includes("session")
      || errorText.includes("login")
      || errorText.includes("access denied");
  } catch {
    return false;
  }
}

async function loginAndGetSession(email, password) {
  const loginPageResponse = await fetch(LOGIN_URL);
  const loginPageHtml = await loginPageResponse.text();
  const csrfToken = extractCsrfToken(loginPageHtml);

  const form = new URLSearchParams();
  form.set("login", email);
  form.set("password", password);
  if (csrfToken) {
    form.set("csrf_token", csrfToken);
  }

  const loginResponse = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html,application/xhtml+xml"
    },
    body: form.toString(),
    redirect: "manual"
  });

  const sessionId = extractSessionId(loginResponse);
  if (!sessionId) {
    const loginBody = await loginResponse.text();
    throw new Error(`Failed to login to Odoo. Status ${loginResponse.status}. ${loginBody.slice(0, 200)}`);
  }

  sessionStore.set(getCacheKey(email), sessionId);
  return sessionId;
}

async function getSessionId(email, password, forceRefresh = false) {
  const cacheKey = getCacheKey(email);
  if (!forceRefresh) {
    const cachedSessionId = sessionStore.get(cacheKey);
    if (cachedSessionId) {
      return cachedSessionId;
    }
  }

  return loginAndGetSession(email, password);
}

async function callCreateEndpoint(payload, sessionId) {
  const response = await fetch(CREATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Cookie": `session_id=${sessionId}`
    },
    body: JSON.stringify(payload),
    redirect: "manual"
  });

  const text = await response.text();
  return { response, text };
}

app.post("/proxy", async (req, res) => {
  try {
    const { auth, payload } = req.body || {};
    const email = auth?.email?.trim();
    const password = auth?.password;
    const requestPayload = payload || req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Missing auth.email or auth.password in request body."
      });
    }

    let sessionId = await getSessionId(email, password);
    let result = await callCreateEndpoint(requestPayload, sessionId);

    if (isSessionExpired(result.response, result.text)) {
      sessionStore.delete(getCacheKey(email));
      sessionId = await getSessionId(email, password, true);
      result = await callCreateEndpoint(requestPayload, sessionId);
    }

    const contentType = result.response.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    res.setHeader("x-odoo-session-id", sessionId);
    res.status(result.response.status).send(result.text);
  } catch (error) {
    console.error("Proxy Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Wrap express app into a handler for Vercel
export default app;

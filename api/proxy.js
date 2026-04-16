import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const ODOO_BASE_URL = "https://sekemportal.hooktrack.life";
const LOGIN_URL = `${ODOO_BASE_URL}/web/login`;
const CREATE_URL = `${ODOO_BASE_URL}/web/dataset/call_kw/per.diem/create`;
const ODOO_EMAIL = process.env.ODOO_EMAIL || "mohamed.ali";
const ODOO_PASSWORD = process.env.ODOO_PASSWORD || "123456";

const app = express();
// image_data is base64 inside JSON, so the payload grows.
app.use(express.json({ limit: "30mb" }));
app.use(cors());

function getSetCookiesFromResponse(response) {
  // node-fetch v3 supports getSetCookie(), but we keep a fallback.
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const raw = response.headers.raw?.();
  return raw?.["set-cookie"] || [];
}

function buildCookieHeader(setCookies) {
  // Convert ["a=1; Path=/; HttpOnly", "b=2; Path=/"] => "a=1; b=2"
  return setCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function extractSessionId(response) {
  const setCookies = getSetCookiesFromResponse(response);

  for (const cookie of setCookies) {
    const match = cookie.match(/session_id=([^;]+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function extractCsrfToken(html) {
  // Odoo login HTML can vary in attribute order/quoting, so match broadly.
  const match =
    html.match(/csrf_token[^>]*value=["']([^"']+)["']/i) ||
    html.match(/<input[^>]*name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i);

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
  const loginPageResponse = await fetch(LOGIN_URL, { redirect: "manual" });
  const loginPageHtml = await loginPageResponse.text();
  const csrfToken = extractCsrfToken(loginPageHtml);
  if (!csrfToken) {
    throw new Error("Failed to extract csrf_token from Odoo /web/login HTML.");
  }
  const cookiesFromLoginPage = buildCookieHeader(getSetCookiesFromResponse(loginPageResponse));

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
      "Accept": "text/html,application/xhtml+xml",
      // CSRF token is tied to the server session, so we must send cookies from the GET /web/login.
      ...(cookiesFromLoginPage ? { Cookie: cookiesFromLoginPage } : {}),
      "Referer": LOGIN_URL
    },
    body: form.toString(),
    redirect: "manual"
  });

  const sessionId = extractSessionId(loginResponse);
  if (!sessionId) {
    const loginBody = await loginResponse.text();
    const tokenPreview = csrfToken ? `${csrfToken.slice(0, 8)}...` : "missing";
    throw new Error(
      `Failed to login to Odoo. Status ${loginResponse.status}. CSRF=${tokenPreview}. ${loginBody.slice(
        0,
        200
      )}`
    );
  }

  return sessionId;
}

let cachedSessionId = null;
let refreshPromise = null;

async function getSessionId(forceRefresh = false) {
  if (!forceRefresh && cachedSessionId) return cachedSessionId;
  if (refreshPromise) return refreshPromise;

  refreshPromise = loginAndGetSession(ODOO_EMAIL, ODOO_PASSWORD)
    .then((sessionId) => {
      cachedSessionId = sessionId;
      return sessionId;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
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
    const requestPayload = req.body?.payload || req.body;

    let sessionId = await getSessionId(false);
    let result = await callCreateEndpoint(requestPayload, sessionId);

    if (isSessionExpired(result.response, result.text)) {
      cachedSessionId = null;
      sessionId = await getSessionId(true);
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

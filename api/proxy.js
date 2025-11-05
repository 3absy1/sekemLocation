import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "10mb" })); // increase limit for image base64
app.use(cors());

app.post("/proxy", async (req, res) => {
  try {
    const response = await fetch("https://sekemportal.hooktrack.life/web/dataset/call_kw/per.diem/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Cookie": "session_id=e1a84f98065efc766986f6e50aec056fe6ed36c7"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.text();
    res.status(response.status).send(data);
  } catch (error) {
    console.error("Proxy Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Wrap express app into a handler for Vercel
export default app;

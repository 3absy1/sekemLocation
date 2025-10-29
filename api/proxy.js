import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

app.post("/proxy", async (req, res) => {
  try {
    const response = await fetch("https://sekemportal.hooktrack.life/web/dataset/call_kw/per.diem/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Cookie": "session_id=14675a2df9421631a80754b6dcf3960d6e7de827"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.text();
    res.status(response.status).send(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default app;

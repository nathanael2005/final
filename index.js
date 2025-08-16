// index.js
import "dotenv/config"; // ✅ Load .env automatically
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
  console.error("❌ Missing TELEGRAM_TOKEN or GEMINI_API_KEY in environment!");
  process.exit(1);
}

// --- Gemini Setup ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- Express App ---
const app = express();
app.use(express.json());

// --- Telegram Bot ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;

  if (!userText) return;

  try {
    const result = await model.generateContent(userText);
    const reply = result.response.candidates?.[0]?.content?.parts?.[0]?.text || "🤖 No reply from Gemini.";

    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("❌ Error handling message:", err);
    await bot.sendMessage(chatId, "⚠️ Something went wrong, please try again.");
  }
});

// --- Express Route (health check) ---
app.get("/", (req, res) => {
  res.send("✅ Telegram + Gemini bot is running!");
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});

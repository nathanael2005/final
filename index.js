// index.js
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Load environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://your-app.onrender.com`; // fallback

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
  console.error("❌ Missing TELEGRAM_TOKEN or GEMINI_API_KEY in environment!");
  process.exit(1);
}

// ✅ Initialize Telegram bot (webhook mode for Render)
const bot = new TelegramBot(TELEGRAM_TOKEN);
const webhookPath = `/bot${TELEGRAM_TOKEN}`;
const webhookUrl = `${RENDER_URL}${webhookPath}`;

// ✅ Set webhook
bot.setWebHook(webhookUrl).then(() => {
  console.log(`🚀 Telegram webhook set to: ${webhookUrl}`);
});

// ✅ Express middleware
app.use(express.json());

// ✅ Handle Telegram updates
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ✅ Initialize Gemini API
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Pick your default model (can change dynamically if needed)
const MODEL = "gemini-1.5-flash";

// ✅ Handle incoming messages
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  console.log(`📩 Message from ${chatId}: ${text}`);

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(text);
    const reply = result.response.text();

    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("❌ Error from Gemini:", err);
    await bot.sendMessage(chatId, "⚠️ Sorry, something went wrong. Try again later.");
  }
});

// ✅ Start server
app.get("/", (req, res) => {
  res.send("✅ Bot is running!");
});

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});

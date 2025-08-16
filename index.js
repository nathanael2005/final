// index.js
import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- API & Environment Setup ---
console.log("Initializing services...");

// Check for the correct environment variable name here
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !RENDER_EXTERNAL_URL) {
    console.error("❌ Missing required environment variables.");
    process.exit(1);
}

// --- Express App ---
const app = express();
app.use(express.json());

// --- Telegram Bot (Webhook Mode) ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

bot.setWebhook(`${RENDER_EXTERNAL_URL}/bot${TELEGRAM_TOKEN}`);
console.log(`✅ Webhook set to ${RENDER_EXTERNAL_URL}/bot${TELEGRAM_TOKEN}`);

// --- Gemini Setup ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- Telegram Message Handler ---
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

// --- Express Routes ---

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get("/", (req, res) => {
    res.send("✅ Telegram + Gemini bot is running!");
});

// --- Start server ---
app.listen(PORT, () => {
    console.log(`🌍 Server running on port ${PORT}`);
});

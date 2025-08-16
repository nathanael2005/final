import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch"; // needed for webhook check

const app = express();
app.use(express.json());

// ============================
// CONFIG
// ============================
const telegramToken = process.env.TELEGRAM_TOKEN; // put your bot token in Render environment
const renderUrl = process.env.RENDER_EXTERNAL_URL; // Render automatically sets this
const port = process.env.PORT || 3000;

if (!telegramToken) {
  console.error("❌ TELEGRAM_TOKEN is missing in environment variables");
  process.exit(1);
}

if (!renderUrl) {
  console.error("❌ RENDER_EXTERNAL_URL is missing");
  process.exit(1);
}

// ============================
// TELEGRAM BOT
// ============================
const bot = new TelegramBot(telegramToken);

// Webhook URL
const webhookUrl = `${renderUrl}/bot${telegramToken}`;

// Set webhook on startup
bot.setWebHook(webhookUrl)
  .then(() => console.log("✅ Webhook set:", webhookUrl))
  .catch(err => console.error("❌ Error setting webhook:", err));

// ============================
// EXPRESS ROUTES
// ============================

// Root check
app.get("/", (req, res) => {
  res.send("🚀 Bot server is running");
});

// Webhook endpoint for Telegram
app.post(`/bot${telegramToken}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Extra route: Check current webhook info
app.get("/check-webhook", async (req, res) => {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${telegramToken}/getWebhookInfo`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// BOT COMMANDS
// ============================
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log("📩 Message from user:", text);

  if (text === "/start") {
    bot.sendMessage(chatId, "Hello 👋, I’m alive and connected to Render!");
  } else {
    bot.sendMessage(chatId, `You said: ${text}`);
  }
});

// ============================
// START SERVER
// ============================
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

// Load environment variables from the .env file
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Bottleneck = require('bottleneck'); // NEW: rate limiter

// --- INITIALIZE APIS ---
console.log("Initializing services...");

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

const bot = new TelegramBot(telegramToken, { polling: true });

const genAI = new GoogleGenerativeAI(geminiApiKey);
// CHANGED: Use gemini-2.0-flash
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

console.log("Services initialized. Bot is starting...");

// --- NEW: OBJECT TO STORE CHAT SESSIONS FOR EACH USER ---
const chatSessions = {};

// --- NEW: DEFINE THE BOT'S PERSONALITY WITH A SYSTEM PROMPT ---
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Your writing style is natural, engaging, and helpful, like talking to a clever and empathetic friend. You avoid robotic language and excessive markdown formatting. You aim to provide great conversation and accurate information.";

// --- NEW: Simple limiter to avoid hitting quota too fast ---
const limiter = new Bottleneck({
  minTime: 500, // 1 request every 0.5s
  maxConcurrent: 1
});

// --- BOT LOGIC ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/')) return;
  
  try {
    await bot.sendChatAction(chatId, 'typing');

    // Get or create a chat session
    if (!chatSessions[chatId]) {
      console.log(`Creating new chat session for chatId: ${chatId}`);
      chatSessions[chatId] = model.startChat({
        history: [
          { role: "user", parts: [{ text: "Hello, let's have a great conversation." }] },
          { role: "model", parts: [{ text: systemPrompt }] },
        ],
        generationConfig: { maxOutputTokens: 1000 },
      });
    }

    const userChat = chatSessions[chatId];

    // Use limiter to control API calls
    const geminiText = await limiter.schedule(async () => {
      const result = await userChat.sendMessage(userMessage);
      const response = await result.response;
      return response.text();
    });

    bot.sendMessage(chatId, geminiText);

  } catch (error) {
    console.error("DETAILED ERROR calling Gemini API:", error.message);
    bot.sendMessage(chatId, "Sorry, I'm having a little trouble thinking right now. Please try again later.");
  }
});

console.log("Telegram bot is now running with memory and personality.");

// --- WEB SERVER FOR RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send('Hello! Your advanced Gemini-powered Telegram bot is alive.');
});
app.listen(port, () => {
  console.log(`Web server for health checks running on port ${port}`);
});

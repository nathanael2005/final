// Load environment variables from the .env file
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- INITIALIZE APIS ---
console.log("Initializing services...");

// Get API keys from the .env file
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

// +++ START OF DEBUG CODE +++
// This will show us exactly what key the application is seeing.
const keyForDebug = geminiApiKey ? `...${geminiApiKey.slice(-4)}` : 'Key is undefined or null';
console.log(`DEBUG: Gemini Key being used ends with: ${keyForDebug}`);
// +++ END OF DEBUG CODE +++

// Initialize the Telegram Bot
const bot = new TelegramBot(telegramToken, { polling: true });

// Initialize the Google Gemini AI Model
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

console.log("Services initialized. Bot is starting...");


// --- BOT LOGIC ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/')) {
    return;
  }
  
  try {
    await bot.sendChatAction(chatId, 'typing');
    const result = await model.generateContent(userMessage);
    const response = await result.response;
    const geminiText = response.text();
    bot.sendMessage(chatId, geminiText);

  } catch (error) {
    // We will now log the detailed error
    console.error("DETAILED ERROR calling Gemini API:", error.message);
    bot.sendMessage(chatId, "Sorry, I ran into an error. Please try again later.");
  }
});

console.log("Telegram bot is now running and connected to Gemini.");


// --- WEB SERVER FOR RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send('Hello! Your Gemini-powered Telegram bot is alive.');
});
app.listen(port, () => {
  console.log(`Web server for health checks running on port ${port}`);
});

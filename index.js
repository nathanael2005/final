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

// Initialize the Telegram Bot
const bot = new TelegramBot(telegramToken, { polling: true });

// Initialize the Google Gemini AI Model
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

console.log("Services initialized. Bot is starting...");


// --- BOT LOGIC ---
// This listens for any message and sends it to Gemini
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  // Ignore commands or empty messages
  if (!userMessage || userMessage.startsWith('/')) {
    return;
  }
  
  try {
    // Let the user know the bot is thinking
    await bot.sendChatAction(chatId, 'typing');

    // Send the user's message to the Gemini model
    const result = await model.generateContent(userMessage);
    const response = await result.response;
    const geminiText = response.text();

    // Send Gemini's response back to the user
    bot.sendMessage(chatId, geminiText);

  } catch (error) {
    console.error("Error calling Gemini API:", error);
    bot.sendMessage(chatId, "Sorry, I ran into an error. Please try again later.");
  }
});

console.log("Telegram bot is now running and connected to Gemini.");


// --- WEB SERVER FOR RENDER ---
// This part keeps the bot alive on Render's free tier
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello! Your Gemini-powered Telegram bot is alive.');
});

app.listen(port, () => {
  console.log(`Web server for health checks running on port ${port}`);
});
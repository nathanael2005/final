// Load environment variables from the .env file
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- INITIALIZE APIS ---
console.log("Initializing services...");

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

const bot = new TelegramBot(telegramToken, { polling: true });

const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

console.log("Services initialized. Bot is starting...");


// --- NEW: OBJECT TO STORE CHAT SESSIONS FOR EACH USER ---
const chatSessions = {};

// --- NEW: DEFINE THE BOT'S PERSONALITY WITH A SYSTEM PROMPT ---
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Your writing style is natural, engaging, and helpful, like talking to a clever and empathetic friend. You avoid robotic language and excessive markdown formatting (like using '*' or '**'). You are designed to be accessible and understandable to everyone. Your goal is to provide great conversation and accurate information.";


// --- BOT LOGIC ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/')) {
    return;
  }
  
  try {
    await bot.sendChatAction(chatId, 'typing');

    // --- NEW: GET OR CREATE A CHAT SESSION FOR THE USER ---
    if (!chatSessions[chatId]) {
      console.log(`Creating new chat session for chatId: ${chatId}`);
      // Start a new chat with the system prompt to set the personality
      chatSessions[chatId] = model.startChat({
        history: [
          { role: "user", parts: [{ text: "Hello, let's have a great conversation." }] },
          { role: "model", parts: [{ text: systemPrompt }] },
        ],
        generationConfig: {
          maxOutputTokens: 1000,
        },
      });
    }

    // Get the user's specific chat session
    const userChat = chatSessions[chatId];
    
    // --- NEW: SEND MESSAGE THROUGH THE CHAT SESSION TO MAINTAIN HISTORY ---
    const result = await userChat.sendMessage(userMessage);
    const response = await result.response;
    const geminiText = response.text();

    bot.sendMessage(chatId, geminiText);

  } catch (error) {
    console.error("DETAILED ERROR calling Gemini API:", error.message);
    bot.sendMessage(chatId, "Sorry, I'm having a little trouble thinking right now. Please try again in a moment.");
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

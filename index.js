// index.js
// Zero-dep, minimal-change version of your bot.
// - Uses gemini-2.0-flash
// - Adds rate limiting + retry (no external packages)
// - Deduplicates duplicate Telegram updates

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- INITIALIZE APIS ---
console.log("Initializing services...");

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!telegramToken || !geminiApiKey) {
  console.error("Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY in environment.");
  process.exit(1);
}

const bot = new TelegramBot(telegramToken, { polling: true });

const genAI = new GoogleGenerativeAI(geminiApiKey);
// CHANGED: Use gemini-2.0-flash (main model)
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

console.log("Services initialized. Bot is starting...");

// --- SESSION STORAGE (per chat) ---
const chatSessions = {};

// --- BOT PERSONALITY (system prompt) ---
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Your writing style is natural, engaging, and helpful, like talking to a clever and empathetic friend. You avoid robotic language and excessive markdown formatting. You aim to provide great conversation and accurate information.";

// --- DEDUP: prevent processing same Telegram update twice ---
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
  if (!messageId) return true;
  if (processedMsgIds.has(messageId)) return false;
  processedMsgIds.add(messageId);
  // expire after 6 hours
  setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
  return true;
}

// --- ZERO-DEP RATE LIMITER + QUEUE ---
// minGap = milliseconds between starting tasks (avoids bursts)
// concurrency = number of parallel calls allowed
function createLimiter({ minGap = 600, concurrency = 1 } = {}) {
  let active = 0;
  let last = 0;
  const q = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function pump() {
    if (active >= concurrency || q.length === 0) return;
    active++;
    const { fn, resolve, reject } = q.shift();
    const wait = Math.max(0, minGap - (Date.now() - last));
    if (wait) await sleep(wait);
    try {
      last = Date.now();
      const r = await fn();
      resolve(r);
    } catch (err) {
      reject(err);
    } finally {
      active--;
      // schedule next pump microtask so the queue flows continuously
      setImmediate(pump);
    }
  }

  return (fn) =>
    new Promise((resolve, reject) => {
      q.push({ fn, resolve, reject });
      pump();
    });
}
const limiter = createLimiter({ minGap: 600, concurrency: 1 });

// --- CALL WRAPPER: limiter + retry/backoff (handles 429s) ---
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;
  while (true) {
    try {
      // run the task through the queue/limiter
      return await limiter(taskFn);
    } catch (err) {
      attempt++;
      const msg = String(err?.message || "");
      const status = err?.status || err?.response?.status || null;
      const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);
      if (!is429 || attempt >= maxAttempts) throw err;
      // exponential backoff (2s, 4s, ...)
      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      console.warn(`Gemini rate-limited (attempt ${attempt}). backing off ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

// --- BOT LOGIC ---
bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const userMessage = msg.text;
  const messageId = msg.message_id;

  if (!chatId || !userMessage || userMessage.startsWith('/')) return;
  if (!shouldProcessOnce(messageId)) return; // avoid duplicate processing

  try {
    await bot.sendChatAction(chatId, 'typing');

    // create a persistent chat session with the system prompt if missing
    if (!chatSessions[chatId]) {
      console.log(`Creating new chat session for chatId: ${chatId}`);
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

    const userChat = chatSessions[chatId];

    // run through limiter + retry
    const geminiText = await callGeminiWithRetry(async () => {
      const result = await userChat.sendMessage(userMessage);
      const response = await result.response;
      // response.text may be a function in some SDK versions
      const text = typeof response.text === "function" ? response.text() : response.text;
      return text || "Sorry, I couldn't produce a response.";
    });

    // send to user
    await bot.sendMessage(chatId, geminiText);

  } catch (error) {
    console.error("DETAILED ERROR calling Gemini API:", error);
    const errMsg = String(error?.message || "");
    if (/429|quota|rate limit|too many requests/i.test(errMsg)) {
      await bot.sendMessage(chatId, "I'm currently being rate-limited by the AI service. Try again in a few minutes — or consider enabling billing / reducing request rate.");
    } else {
      await bot.sendMessage(chatId, "Sorry, I'm having a little trouble thinking right now. Please try again later.");
    }
  }
});

console.log("Telegram bot is now running with memory and personality.");

// --- WEB SERVER FOR HEALTH CHECKS ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send('Hello! Your advanced Gemini-powered Telegram bot is alive.');
});
app.listen(port, () => {
  console.log(`Web server for health checks running on port ${port}`);
});

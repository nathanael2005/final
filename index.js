// index.js (CommonJS, ready for Render)
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.EXTERNAL_URL || null;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_TOKEN in env");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in env");
  process.exit(1);
}
if (!RENDER_URL) {
  console.warn("RENDER_EXTERNAL_URL not set. Set it to your public URL (https://...). Webhook may fail until set.");
}

// ---------- EXPRESS SETUP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- TELEGRAM (webhook mode) ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const webhookPath = `/bot${TELEGRAM_TOKEN}`;
const webhookUrl = RENDER_URL ? `${RENDER_URL}${webhookPath}` : null;

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const models = [
  "gemini-2.5-flash",
  "gemini-2.5-flashlite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];
let currentModelIndex = 0;
function currentModelName() { return models[currentModelIndex]; }
function getGenerativeModel() { return genAI.getGenerativeModel({ model: currentModelName() }); }

// ---------- SESSIONS & PROMPT ----------
const chatSessions = {}; // chatId -> { modelName, chatInstance, history: [{role, text}] }
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Write conversationally and helpfully.";

// ---------- DEDUP ----------
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
  if (!messageId) return true;
  if (processedMsgIds.has(messageId)) return false;
  processedMsgIds.add(messageId);
  // expire after 6 hours
  setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
  return true;
}

// ---------- RATE LIMITER (zero-dep) ----------
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

// ---------- MIGRATE SESSIONS WHEN MODEL CHANGES ----------
async function migrateSessionsToModel(newIndex) {
  const newModelName = models[newIndex];
  console.log(`Migrating ${Object.keys(chatSessions).length} sessions to model ${newModelName}...`);
  const promises = Object.keys(chatSessions).map(async (chatId) => {
    const session = chatSessions[chatId];
    try {
      const model = genAI.getGenerativeModel({ model: newModelName });
      const historyForSDK = (session.history || []).map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }));
      // Include systemPrompt at the start if not present
      if (!historyForSDK.some(h => h.role === 'system')) {
        historyForSDK.unshift({ role: 'system', parts: [{ text: systemPrompt }] });
      }
      const newChat = await model.startChat({
        history: historyForSDK,
        generationConfig: { maxOutputTokens: 1000 }
      });
      chatSessions[chatId].chatInstance = newChat;
      chatSessions[chatId].modelName = newModelName;
      console.log(`Migrated chat ${chatId} -> ${newModelName}`);
    } catch (err) {
      console.error(`Failed migrating chat ${chatId}:`, err?.message || err);
      // keep existing session if migration fails
    }
  });
  await Promise.all(promises);
}

// ---------- CALL WRAPPER: limiter + retry + model switch ----------
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;

  while (true) {
    try {
      // Run the task through the rate limiter queue
      return await limiter(taskFn);
    } catch (err) {
      attempt++;
      const msg = String(err?.message || "");
      const status = err?.status || err?.response?.status || null;
      const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);

      if (!is429) throw err;

      console.warn(`Rate limit (429) detected on model ${currentModelName()} (attempt ${attempt}).`);

      // Try switching to next model if available
      if (currentModelIndex < models.length - 1) {
        currentModelIndex++;
        console.log(`Switching to fallback model: ${currentModelName()}`);
        // migrate existing sessions to the new model (best-effort)
        try {
          await migrateSessionsToModel(currentModelIndex);
        } catch (mErr) {
          console.error("Session migration error:", mErr?.message || mErr);
        }
      } else {
        console.log("Already on last fallback model; will backoff and retry.");
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      console.log(`Backing off for ${backoff}ms before retrying...`);
      await sleep(backoff);
    }
  }
}

// ---------- HELPERS TO CREATE SESSIONS ----------
async function createSessionForChat(chatId) {
  const model = getGenerativeModel();
  const historyForSDK = [
    { role: 'system', parts: [{ text: systemPrompt }] },
    { role: 'user', parts: [{ text: "Hello, let's have a great conversation." }] }
  ];
  const chat = await model.startChat({
    history: historyForSDK,
    generationConfig: { maxOutputTokens: 1000 }
  });
  chatSessions[chatId] = {
    modelName: currentModelName(),
    chatInstance: chat,
    history: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: "Hello, let's have a great conversation." }
    ]
  };
  return chatSessions[chatId];
}

// ---------- TELEGRAM HANDLER ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const userMessage = msg.text;
  const messageId = msg.message_id;

  if (!chatId || !userMessage) return;
  if (!shouldProcessOnce(messageId)) return;
  if (userMessage.startsWith('/')) {
    // Example commands
    if (userMessage === '/start') {
      await bot.sendMessage(chatId, 'Hello! I am awake and using model: ' + currentModelName());
    }
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    // ensure session exists
    let session = chatSessions[chatId];
    if (!session) {
      console.log(`Creating session for chat ${chatId} on model ${currentModelName()}`);
      session = await createSessionForChat(chatId);
    }

    // push user message to history
    session.history.push({ role: 'user', text: userMessage });

    // send the message through wrapper (limiter + retry + model switching)
    const geminiText = await callGeminiWithRetry(async () => {
      // use the chatInstance attached to the session
      const chatInstance = session.chatInstance;
      // sendMessage on the chat instance; many SDKs accept string directly
      const result = await chatInstance.sendMessage(userMessage);
      // result.response may be a promise or the response object
      const response = await result.response;
      // response.text might be function or string
      const text = typeof response.text === 'function' ? response.text() : response.text;
      return text || "Sorry, I couldn't produce a response.";
    });

    // push model reply to history
    session.history.push({ role: 'model', text: geminiText });

    // send back to Telegram user
    await bot.sendMessage(chatId, geminiText);
  } catch (err) {
    console.error("Error processing message:", err?.message || err);
    const errMsg = String(err?.message || "");
    if (/429|quota|rate limit|too many requests/i.test(errMsg)) {
      await bot.sendMessage(chatId, "I'm currently being rate-limited by the AI service. Try again in a few moments — I'm switching models or backing off.");
    } else {
      await bot.sendMessage(chatId, "Sorry, I ran into a problem. Try again in a bit.");
    }
  }
});

// ---------- EXPRESS ROUTES ----------
app.get('/', (req, res) => res.send('Bot server alive'));

app.get('/check-webhook', async (req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Telegram webhook endpoint
app.post(webhookPath, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("processUpdate error:", err);
    res.sendStatus(500);
  }
});

// ---------- START SERVER + SET WEBHOOK ----------
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (!webhookUrl) {
    console.warn("RENDER_EXTERNAL_URL not set, webhook NOT configured automatically. Set RENDER_EXTERNAL_URL env var to your public URL.");
    return;
  }
  try {
    // drop pending updates so previous test polling won't spam you
    await bot.setWebHook(webhookUrl, { drop_pending_updates: true });
    console.log("Webhook set to:", webhookUrl);
  } catch (err) {
    console.error("Failed to set webhook:", err?.message || err);
  }
});
// index.js (CommonJS, ready for Render)
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.EXTERNAL_URL || null;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_TOKEN in env");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in env");
  process.exit(1);
}
if (!RENDER_URL) {
  console.warn("RENDER_EXTERNAL_URL not set. Set it to your public URL (https://...). Webhook may fail until set.");
}

// ---------- EXPRESS SETUP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- TELEGRAM (webhook mode) ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const webhookPath = `/bot${TELEGRAM_TOKEN}`;
const webhookUrl = RENDER_URL ? `${RENDER_URL}${webhookPath}` : null;

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const models = [
  "gemini-2.5-flash",
  "gemini-2.5-flashlite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];
let currentModelIndex = 0;
function currentModelName() { return models[currentModelIndex]; }
function getGenerativeModel() { return genAI.getGenerativeModel({ model: currentModelName() }); }

// ---------- SESSIONS & PROMPT ----------
const chatSessions = {}; // chatId -> { modelName, chatInstance, history: [{role, text}] }
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Write conversationally and helpfully.";

// ---------- DEDUP ----------
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
  if (!messageId) return true;
  if (processedMsgIds.has(messageId)) return false;
  processedMsgIds.add(messageId);
  // expire after 6 hours
  setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
  return true;
}

// ---------- RATE LIMITER (zero-dep) ----------
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

// ---------- MIGRATE SESSIONS WHEN MODEL CHANGES ----------
async function migrateSessionsToModel(newIndex) {
  const newModelName = models[newIndex];
  console.log(`Migrating ${Object.keys(chatSessions).length} sessions to model ${newModelName}...`);
  const promises = Object.keys(chatSessions).map(async (chatId) => {
    const session = chatSessions[chatId];
    try {
      const model = genAI.getGenerativeModel({ model: newModelName });
      const historyForSDK = (session.history || []).map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }));
      // Include systemPrompt at the start if not present
      if (!historyForSDK.some(h => h.role === 'system')) {
        historyForSDK.unshift({ role: 'system', parts: [{ text: systemPrompt }] });
      }
      const newChat = await model.startChat({
        history: historyForSDK,
        generationConfig: { maxOutputTokens: 1000 }
      });
      chatSessions[chatId].chatInstance = newChat;
      chatSessions[chatId].modelName = newModelName;
      console.log(`Migrated chat ${chatId} -> ${newModelName}`);
    } catch (err) {
      console.error(`Failed migrating chat ${chatId}:`, err?.message || err);
      // keep existing session if migration fails
    }
  });
  await Promise.all(promises);
}

// ---------- CALL WRAPPER: limiter + retry + model switch ----------
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;

  while (true) {
    try {
      // Run the task through the rate limiter queue
      return await limiter(taskFn);
    } catch (err) {
      attempt++;
      const msg = String(err?.message || "");
      const status = err?.status || err?.response?.status || null;
      const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);

      if (!is429) throw err;

      console.warn(`Rate limit (429) detected on model ${currentModelName()} (attempt ${attempt}).`);

      // Try switching to next model if available
      if (currentModelIndex < models.length - 1) {
        currentModelIndex++;
        console.log(`Switching to fallback model: ${currentModelName()}`);
        // migrate existing sessions to the new model (best-effort)
        try {
          await migrateSessionsToModel(currentModelIndex);
        } catch (mErr) {
          console.error("Session migration error:", mErr?.message || mErr);
        }
      } else {
        console.log("Already on last fallback model; will backoff and retry.");
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      console.log(`Backing off for ${backoff}ms before retrying...`);
      await sleep(backoff);
    }
  }
}

// ---------- HELPERS TO CREATE SESSIONS ----------
async function createSessionForChat(chatId) {
  const model = getGenerativeModel();
  const historyForSDK = [
    { role: 'system', parts: [{ text: systemPrompt }] },
    { role: 'user', parts: [{ text: "Hello, let's have a great conversation." }] }
  ];
  const chat = await model.startChat({
    history: historyForSDK,
    generationConfig: { maxOutputTokens: 1000 }
  });
  chatSessions[chatId] = {
    modelName: currentModelName(),
    chatInstance: chat,
    history: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: "Hello, let's have a great conversation." }
    ]
  };
  return chatSessions[chatId];
}

// ---------- TELEGRAM HANDLER ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const userMessage = msg.text;
  const messageId = msg.message_id;

  if (!chatId || !userMessage) return;
  if (!shouldProcessOnce(messageId)) return;
  if (userMessage.startsWith('/')) {
    // Example commands
    if (userMessage === '/start') {
      await bot.sendMessage(chatId, 'Hello! I am awake and using model: ' + currentModelName());
    }
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    // ensure session exists
    let session = chatSessions[chatId];
    if (!session) {
      console.log(`Creating session for chat ${chatId} on model ${currentModelName()}`);
      session = await createSessionForChat(chatId);
    }

    // push user message to history
    session.history.push({ role: 'user', text: userMessage });

    // send the message through wrapper (limiter + retry + model switching)
    const geminiText = await callGeminiWithRetry(async () => {
      // use the chatInstance attached to the session
      const chatInstance = session.chatInstance;
      // sendMessage on the chat instance; many SDKs accept string directly
      const result = await chatInstance.sendMessage(userMessage);
      // result.response may be a promise or the response object
      const response = await result.response;
      // response.text might be function or string
      const text = typeof response.text === 'function' ? response.text() : response.text;
      return text || "Sorry, I couldn't produce a response.";
    });

    // push model reply to history
    session.history.push({ role: 'model', text: geminiText });

    // send back to Telegram user
    await bot.sendMessage(chatId, geminiText);
  } catch (err) {
    console.error("Error processing message:", err?.message || err);
    const errMsg = String(err?.message || "");
    if (/429|quota|rate limit|too many requests/i.test(errMsg)) {
      await bot.sendMessage(chatId, "I'm currently being rate-limited by the AI service. Try again in a few moments — I'm switching models or backing off.");
    } else {
      await bot.sendMessage(chatId, "Sorry, I ran into a problem. Try again in a bit.");
    }
  }
});

// ---------- EXPRESS ROUTES ----------
app.get('/', (req, res) => res.send('Bot server alive'));

app.get('/check-webhook', async (req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Telegram webhook endpoint
app.post(webhookPath, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("processUpdate error:", err);
    res.sendStatus(500);
  }
});

// ---------- START SERVER + SET WEBHOOK ----------
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (!webhookUrl) {
    console.warn("RENDER_EXTERNAL_URL not set, webhook NOT configured automatically. Set RENDER_EXTERNAL_URL env var to your public URL.");
    return;
  }
  try {
    // drop pending updates so previous test polling won't spam you
    await bot.setWebHook(webhookUrl, { drop_pending_updates: true });
    console.log("Webhook set to:", webhookUrl);
  } catch (err) {
    console.error("Failed to set webhook:", err?.message || err);
  }
});
// index.js (CommonJS, ready for Render)
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.EXTERNAL_URL || null;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_TOKEN in env");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in env");
  process.exit(1);
}
if (!RENDER_URL) {
  console.warn("RENDER_EXTERNAL_URL not set. Set it to your public URL (https://...). Webhook may fail until set.");
}

// ---------- EXPRESS SETUP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- TELEGRAM (webhook mode) ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const webhookPath = `/bot${TELEGRAM_TOKEN}`;
const webhookUrl = RENDER_URL ? `${RENDER_URL}${webhookPath}` : null;

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const models = [
  "gemini-2.5-flash",
  "gemini-2.5-flashlite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];
let currentModelIndex = 0;
function currentModelName() { return models[currentModelIndex]; }
function getGenerativeModel() { return genAI.getGenerativeModel({ model: currentModelName() }); }

// ---------- SESSIONS & PROMPT ----------
const chatSessions = {}; // chatId -> { modelName, chatInstance, history: [{role, text}] }
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Write conversationally and helpfully.";

// ---------- DEDUP ----------
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
  if (!messageId) return true;
  if (processedMsgIds.has(messageId)) return false;
  processedMsgIds.add(messageId);
  // expire after 6 hours
  setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
  return true;
}

// ---------- RATE LIMITER (zero-dep) ----------
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

// ---------- MIGRATE SESSIONS WHEN MODEL CHANGES ----------
async function migrateSessionsToModel(newIndex) {
  const newModelName = models[newIndex];
  console.log(`Migrating ${Object.keys(chatSessions).length} sessions to model ${newModelName}...`);
  const promises = Object.keys(chatSessions).map(async (chatId) => {
    const session = chatSessions[chatId];
    try {
      const model = genAI.getGenerativeModel({ model: newModelName });
      const historyForSDK = (session.history || []).map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }));
      // Include systemPrompt at the start if not present
      if (!historyForSDK.some(h => h.role === 'system')) {
        historyForSDK.unshift({ role: 'system', parts: [{ text: systemPrompt }] });
      }
      const newChat = await model.startChat({
        history: historyForSDK,
        generationConfig: { maxOutputTokens: 1000 }
      });
      chatSessions[chatId].chatInstance = newChat;
      chatSessions[chatId].modelName = newModelName;
      console.log(`Migrated chat ${chatId} -> ${newModelName}`);
    } catch (err) {
      console.error(`Failed migrating chat ${chatId}:`, err?.message || err);
      // keep existing session if migration fails
    }
  });
  await Promise.all(promises);
}

// ---------- CALL WRAPPER: limiter + retry + model switch ----------
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;

  while (true) {
    try {
      // Run the task through the rate limiter queue
      return await limiter(taskFn);
    } catch (err) {
      attempt++;
      const msg = String(err?.message || "");
      const status = err?.status || err?.response?.status || null;
      const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);

      if (!is429) throw err;

      console.warn(`Rate limit (429) detected on model ${currentModelName()} (attempt ${attempt}).`);

      // Try switching to next model if available
      if (currentModelIndex < models.length - 1) {
        currentModelIndex++;
        console.log(`Switching to fallback model: ${currentModelName()}`);
        // migrate existing sessions to the new model (best-effort)
        try {
          await migrateSessionsToModel(currentModelIndex);
        } catch (mErr) {
          console.error("Session migration error:", mErr?.message || mErr);
        }
      } else {
        console.log("Already on last fallback model; will backoff and retry.");
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      console.log(`Backing off for ${backoff}ms before retrying...`);
      await sleep(backoff);
    }
  }
}

// ---------- HELPERS TO CREATE SESSIONS ----------
async function createSessionForChat(chatId) {
  const model = getGenerativeModel();
  const historyForSDK = [
    { role: 'system', parts: [{ text: systemPrompt }] },
    { role: 'user', parts: [{ text: "Hello, let's have a great conversation." }] }
  ];
  const chat = await model.startChat({
    history: historyForSDK,
    generationConfig: { maxOutputTokens: 1000 }
  });
  chatSessions[chatId] = {
    modelName: currentModelName(),
    chatInstance: chat,
    history: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: "Hello, let's have a great conversation." }
    ]
  };
  return chatSessions[chatId];
}

// ---------- TELEGRAM HANDLER ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const userMessage = msg.text;
  const messageId = msg.message_id;

  if (!chatId || !userMessage) return;
  if (!shouldProcessOnce(messageId)) return;
  if (userMessage.startsWith('/')) {
    // Example commands
    if (userMessage === '/start') {
      await bot.sendMessage(chatId, 'Hello! I am awake and using model: ' + currentModelName());
    }
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    // ensure session exists
    let session = chatSessions[chatId];
    if (!session) {
      console.log(`Creating session for chat ${chatId} on model ${currentModelName()}`);
      session = await createSessionForChat(chatId);
    }

    // push user message to history
    session.history.push({ role: 'user', text: userMessage });

    // send the message through wrapper (limiter + retry + model switching)
    const geminiText = await callGeminiWithRetry(async () => {
      // use the chatInstance attached to the session
      const chatInstance = session.chatInstance;
      // sendMessage on the chat instance; many SDKs accept string directly
      const result = await chatInstance.sendMessage(userMessage);
      // result.response may be a promise or the response object
      const response = await result.response;
      // response.text might be function or string
      const text = typeof response.text === 'function' ? response.text() : response.text;
      return text || "Sorry, I couldn't produce a response.";
    });

    // push model reply to history
    session.history.push({ role: 'model', text: geminiText });

    // send back to Telegram user
    await bot.sendMessage(chatId, geminiText);
  } catch (err) {
    console.error("Error processing message:", err?.message || err);
    const errMsg = String(err?.message || "");
    if (/429|quota|rate limit|too many requests/i.test(errMsg)) {
      await bot.sendMessage(chatId, "I'm currently being rate-limited by the AI service. Try again in a few moments — I'm switching models or backing off.");
    } else {
      await bot.sendMessage(chatId, "Sorry, I ran into a problem. Try again in a bit.");
    }
  }
});

// ---------- EXPRESS ROUTES ----------
app.get('/', (req, res) => res.send('Bot server alive'));

app.get('/check-webhook', async (req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Telegram webhook endpoint
app.post(webhookPath, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("processUpdate error:", err);
    res.sendStatus(500);
  }
});

// ---------- START SERVER + SET WEBHOOK ----------
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (!webhookUrl) {
    console.warn("RENDER_EXTERNAL_URL not set, webhook NOT configured automatically. Set RENDER_EXTERNAL_URL env var to your public URL.");
    return;
  }
  try {
    // drop pending updates so previous test polling won't spam you
    await bot.setWebHook(webhookUrl, { drop_pending_updates: true });
    console.log("Webhook set to:", webhookUrl);
  } catch (err) {
    console.error("Failed to set webhook:", err?.message || err);
  }
});
// index.js (CommonJS, ready for Render)
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.EXTERNAL_URL || null;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_TOKEN in env");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in env");
  process.exit(1);
}
if (!RENDER_URL) {
  console.warn("RENDER_EXTERNAL_URL not set. Set it to your public URL (https://...). Webhook may fail until set.");
}

// ---------- EXPRESS SETUP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- TELEGRAM (webhook mode) ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const webhookPath = `/bot${TELEGRAM_TOKEN}`;
const webhookUrl = RENDER_URL ? `${RENDER_URL}${webhookPath}` : null;

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const models = [
  "gemini-2.5-flash",
  "gemini-2.5-flashlite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];
let currentModelIndex = 0;
function currentModelName() { return models[currentModelIndex]; }
function getGenerativeModel() { return genAI.getGenerativeModel({ model: currentModelName() }); }

// ---------- SESSIONS & PROMPT ----------
const chatSessions = {}; // chatId -> { modelName, chatInstance, history: [{role, text}] }
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Write conversationally and helpfully.";

// ---------- DEDUP ----------
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
  if (!messageId) return true;
  if (processedMsgIds.has(messageId)) return false;
  processedMsgIds.add(messageId);
  // expire after 6 hours
  setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
  return true;
}

// ---------- RATE LIMITER (zero-dep) ----------
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

// ---------- MIGRATE SESSIONS WHEN MODEL CHANGES ----------
async function migrateSessionsToModel(newIndex) {
  const newModelName = models[newIndex];
  console.log(`Migrating ${Object.keys(chatSessions).length} sessions to model ${newModelName}...`);
  const promises = Object.keys(chatSessions).map(async (chatId) => {
    const session = chatSessions[chatId];
    try {
      const model = genAI.getGenerativeModel({ model: newModelName });
      const historyForSDK = (session.history || []).map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }));
      // Include systemPrompt at the start if not present
      if (!historyForSDK.some(h => h.role === 'system')) {
        historyForSDK.unshift({ role: 'system', parts: [{ text: systemPrompt }] });
      }
      const newChat = await model.startChat({
        history: historyForSDK,
        generationConfig: { maxOutputTokens: 1000 }
      });
      chatSessions[chatId].chatInstance = newChat;
      chatSessions[chatId].modelName = newModelName;
      console.log(`Migrated chat ${chatId} -> ${newModelName}`);
    } catch (err) {
      console.error(`Failed migrating chat ${chatId}:`, err?.message || err);
      // keep existing session if migration fails
    }
  });
  await Promise.all(promises);
}

// ---------- CALL WRAPPER: limiter + retry + model switch ----------
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;

  while (true) {
    try {
      // Run the task through the rate limiter queue
      return await limiter(taskFn);
    } catch (err) {
      attempt++;
      const msg = String(err?.message || "");
      const status = err?.status || err?.response?.status || null;
      const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);

      if (!is429) throw err;

      console.warn(`Rate limit (429) detected on model ${currentModelName()} (attempt ${attempt}).`);

      // Try switching to next model if available
      if (currentModelIndex < models.length - 1) {
        currentModelIndex++;
        console.log(`Switching to fallback model: ${currentModelName()}`);
        // migrate existing sessions to the new model (best-effort)
        try {
          await migrateSessionsToModel(currentModelIndex);
        } catch (mErr) {
          console.error("Session migration error:", mErr?.message || mErr);
        }
      } else {
        console.log("Already on last fallback model; will backoff and retry.");
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      console.log(`Backing off for ${backoff}ms before retrying...`);
      await sleep(backoff);
    }
  }
}

// ---------- HELPERS TO CREATE SESSIONS ----------
async function createSessionForChat(chatId) {
  const model = getGenerativeModel();
  const historyForSDK = [
    { role: 'system', parts: [{ text: systemPrompt }] },
    { role: 'user', parts: [{ text: "Hello, let's have a great conversation." }] }
  ];
  const chat = await model.startChat({
    history: historyForSDK,
    generationConfig: { maxOutputTokens: 1000 }
  });
  chatSessions[chatId] = {
    modelName: currentModelName(),
    chatInstance: chat,
    history: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: "Hello, let's have a great conversation." }
    ]
  };
  return chatSessions[chatId];
}

// ---------- TELEGRAM HANDLER ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const userMessage = msg.text;
  const messageId = msg.message_id;

  if (!chatId || !userMessage) return;
  if (!shouldProcessOnce(messageId)) return;
  if (userMessage.startsWith('/')) {
    // Example commands
    if (userMessage === '/start') {
      await bot.sendMessage(chatId, 'Hello! I am awake and using model: ' + currentModelName());
    }
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    // ensure session exists
    let session = chatSessions[chatId];
    if (!session) {
      console.log(`Creating session for chat ${chatId} on model ${currentModelName()}`);
      session = await createSessionForChat(chatId);
    }

    // push user message to history
    session.history.push({ role: 'user', text: userMessage });

    // send the message through wrapper (limiter + retry + model switching)
    const geminiText = await callGeminiWithRetry(async () => {
      // use the chatInstance attached to the session
      const chatInstance = session.chatInstance;
      // sendMessage on the chat instance; many SDKs accept string directly
      const result = await chatInstance.sendMessage(userMessage);
      // result.response may be a promise or the response object
      const response = await result.response;
      // response.text might be function or string
      const text = typeof response.text === 'function' ? response.text() : response.text;
      return text || "Sorry, I couldn't produce a response.";
    });

    // push model reply to history
    session.history.push({ role: 'model', text: geminiText });

    // send back to Telegram user
    await bot.sendMessage(chatId, geminiText);
  } catch (err) {
    console.error("Error processing message:", err?.message || err);
    const errMsg = String(err?.message || "");
    if (/429|quota|rate limit|too many requests/i.test(errMsg)) {
      await bot.sendMessage(chatId, "I'm currently being rate-limited by the AI service. Try again in a few moments — I'm switching models or backing off.");
    } else {
      await bot.sendMessage(chatId, "Sorry, I ran into a problem. Try again in a bit.");
    }
  }
});

// ---------- EXPRESS ROUTES ----------
app.get('/', (req, res) => res.send('Bot server alive'));

app.get('/check-webhook', async (req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Telegram webhook endpoint
app.post(webhookPath, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("processUpdate error:", err);
    res.sendStatus(500);
  }
});

// ---------- START SERVER + SET WEBHOOK ----------
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (!webhookUrl) {
    console.warn("RENDER_EXTERNAL_URL not set, webhook NOT configured automatically. Set RENDER_EXTERNAL_URL env var to your public URL.");
    return;
  }
  try {
    // drop pending updates so previous test polling won't spam you
    await bot.setWebHook(webhookUrl, { drop_pending_updates: true });
    console.log("Webhook set to:", webhookUrl);
  } catch (err) {
    console.error("Failed to set webhook:", err?.message || err);
  }
});
// index.js (CommonJS, ready for Render)
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.EXTERNAL_URL || null;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_TOKEN in env");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in env");
  process.exit(1);
}
if (!RENDER_URL) {
  console.warn("RENDER_EXTERNAL_URL not set. Set it to your public URL (https://...). Webhook may fail until set.");
}

// ---------- EXPRESS SETUP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- TELEGRAM (webhook mode) ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const webhookPath = `/bot${TELEGRAM_TOKEN}`;
const webhookUrl = RENDER_URL ? `${RENDER_URL}${webhookPath}` : null;

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const models = [
  "gemini-2.5-flash",
  "gemini-2.5-flashlite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];
let currentModelIndex = 0;
function currentModelName() { return models[currentModelIndex]; }
function getGenerativeModel() { return genAI.getGenerativeModel({ model: currentModelName() }); }

// ---------- SESSIONS & PROMPT ----------
const chatSessions = {}; // chatId -> { modelName, chatInstance, history: [{role, text}] }
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Write conversationally and helpfully.";

// ---------- DEDUP ----------
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
  if (!messageId) return true;
  if (processedMsgIds.has(messageId)) return false;
  processedMsgIds.add(messageId);
  // expire after 6 hours
  setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
  return true;
}

// ---------- RATE LIMITER (zero-dep) ----------
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

// ---------- MIGRATE SESSIONS WHEN MODEL CHANGES ----------
async function migrateSessionsToModel(newIndex) {
  const newModelName = models[newIndex];
  console.log(`Migrating ${Object.keys(chatSessions).length} sessions to model ${newModelName}...`);
  const promises = Object.keys(chatSessions).map(async (chatId) => {
    const session = chatSessions[chatId];
    try {
      const model = genAI.getGenerativeModel({ model: newModelName });
      const historyForSDK = (session.history || []).map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }));
      // Include systemPrompt at the start if not present
      if (!historyForSDK.some(h => h.role === 'system')) {
        historyForSDK.unshift({ role: 'system', parts: [{ text: systemPrompt }] });
      }
      const newChat = await model.startChat({
        history: historyForSDK,
        generationConfig: { maxOutputTokens: 1000 }
      });
      chatSessions[chatId].chatInstance = newChat;
      chatSessions[chatId].modelName = newModelName;
      console.log(`Migrated chat ${chatId} -> ${newModelName}`);
    } catch (err) {
      console.error(`Failed migrating chat ${chatId}:`, err?.message || err);
      // keep existing session if migration fails
    }
  });
  await Promise.all(promises);
}

// ---------- CALL WRAPPER: limiter + retry + model switch ----------
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;

  while (true) {
    try {
      // Run the task through the rate limiter queue
      return await limiter(taskFn);
    } catch (err) {
      attempt++;
      const msg = String(err?.message || "");
      const status = err?.status || err?.response?.status || null;
      const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);

      if (!is429) throw err;

      console.warn(`Rate limit (429) detected on model ${currentModelName()} (attempt ${attempt}).`);

      // Try switching to next model if available
      if (currentModelIndex < models.length - 1) {
        currentModelIndex++;
        console.log(`Switching to fallback model: ${currentModelName()}`);
        // migrate existing sessions to the new model (best-effort)
        try {
          await migrateSessionsToModel(currentModelIndex);
        } catch (mErr) {
          console.error("Session migration error:", mErr?.message || mErr);
        }
      } else {
        console.log("Already on last fallback model; will backoff and retry.");
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      console.log(`Backing off for ${backoff}ms before retrying...`);
      await sleep(backoff);
    }
  }
}

// ---------- HELPERS TO CREATE SESSIONS ----------
async function createSessionForChat(chatId) {
  const model = getGenerativeModel();
  const historyForSDK = [
    { role: 'system', parts: [{ text: systemPrompt }] },
    { role: 'user', parts: [{ text: "Hello, let's have a great conversation." }] }
  ];
  const chat = await model.startChat({
    history: historyForSDK,
    generationConfig: { maxOutputTokens: 1000 }
  });
  chatSessions[chatId] = {
    modelName: currentModelName(),
    chatInstance: chat,
    history: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: "Hello, let's have a great conversation." }
    ]
  };
  return chatSessions[chatId];
}

// ---------- TELEGRAM HANDLER ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const userMessage = msg.text;
  const messageId = msg.message_id;

  if (!chatId || !userMessage) return;
  if (!shouldProcessOnce(messageId)) return;
  if (userMessage.startsWith('/')) {
    // Example commands
    if (userMessage === '/start') {
      await bot.sendMessage(chatId, 'Hello! I am awake and using model: ' + currentModelName());
    }
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    // ensure session exists
    let session = chatSessions[chatId];
    if (!session) {
      console.log(`Creating session for chat ${chatId} on model ${currentModelName()}`);
      session = await createSessionForChat(chatId);
    }

    // push user message to history
    session.history.push({ role: 'user', text: userMessage });

    // send the message through wrapper (limiter + retry + model switching)
    const geminiText = await callGeminiWithRetry(async () => {
      // use the chatInstance attached to the session
      const chatInstance = session.chatInstance;
      // sendMessage on the chat instance; many SDKs accept string directly
      const result = await chatInstance.sendMessage(userMessage);
      // result.response may be a promise or the response object
      const response = await result.response;
      // response.text might be function or string
      const text = typeof response.text === 'function' ? response.text() : response.text;
      return text || "Sorry, I couldn't produce a response.";
    });

    // push model reply to history
    session.history.push({ role: 'model', text: geminiText });

    // send back to Telegram user
    await bot.sendMessage(chatId, geminiText);
  } catch (err) {
    console.error("Error processing message:", err?.message || err);
    const errMsg = String(err?.message || "");
    if (/429|quota|rate limit|too many requests/i.test(errMsg)) {
      await bot.sendMessage(chatId, "I'm currently being rate-limited by the AI service. Try again in a few moments — I'm switching models or backing off.");
    } else {
      await bot.sendMessage(chatId, "Sorry, I ran into a problem. Try again in a bit.");
    }
  }
});

// ---------- EXPRESS ROUTES ----------
app.get('/', (req, res) => res.send('Bot server alive'));

app.get('/check-webhook', async (req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Telegram webhook endpoint
app.post(webhookPath, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("processUpdate error:", err);
    res.sendStatus(500);
  }
});

// ---------- START SERVER + SET WEBHOOK ----------
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (!webhookUrl) {
    console.warn("RENDER_EXTERNAL_URL not set, webhook NOT configured automatically. Set RENDER_EXTERNAL_URL env var to your public URL.");
    return;
  }
  try {
    // drop pending updates so previous test polling won't spam you
    await bot.setWebHook(webhookUrl, { drop_pending_updates: true });
    console.log("Webhook set to:", webhookUrl);
  } catch (err) {
    console.error("Failed to set webhook:", err?.message || err);
  }
});

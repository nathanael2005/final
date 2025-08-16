// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- INITIALIZE APIS ---
console.log("Initializing services...");

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;
const appUrl = process.env.RENDER_EXTERNAL_URL;
const port = process.env.PORT || 3000;

if (!telegramToken || !geminiApiKey) {
    console.error("Missing required environment variables.");
    process.exit(1);
}

// CORRECTED: Initialize bot with polling disabled to use webhooks
const bot = new TelegramBot(telegramToken, { polling: false });

// MODIFICATION: Set the webhook
if (appUrl) {
    bot.setWebhook(`${appUrl}/bot${telegramToken}`);
    console.log(`Webhook set to ${appUrl}/bot${telegramToken}`);
} else {
    console.log("RENDER_EXTERNAL_URL not set. Webhook not configured. Running in local mode?");
}

const genAI = new GoogleGenerativeAI(geminiApiKey);

// --- MODELS ---
const models = [
    "gemini-2.5-flash",
    "gemini-2.5-flashlite",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro"
];
let currentModelIndex = 0;

function getCurrentModel() {
    return genAI.getGenerativeModel({ model: models[currentModelIndex] });
}

// --- SESSION STORAGE ---
const chatSessions = {};
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Your writing style is natural, engaging, and helpful, like talking to a clever and empathetic friend. You avoid robotic language and excessive markdown formatting. You aim to provide great conversation and accurate information. Keep your answers concise and to the point.";

// --- DEDUPLICATION ---
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
    if (!messageId) return true;
    if (processedMsgIds.has(messageId)) return false;
    processedMsgIds.add(messageId);
    setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
    return true;
}

// --- RATE LIMITER + QUEUE ---
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

// --- GEMINI CALL WITH RETRY + MODEL SWITCH ---
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let attempt = 0;

    while (true) {
        try {
            return await limiter(taskFn);
        } catch (err) {
            attempt++;
            const msg = String(err?.message || "");
            const status = err?.status || err?.response?.status || null;
            const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);

            if (!is429) throw err;

            console.warn(`Rate limit on model ${models[currentModelIndex]} (attempt ${attempt}).`);

            if (currentModelIndex < models.length - 1) {
                currentModelIndex++;
                console.log(`Switching to fallback model: ${models[currentModelIndex]}`);
            } else {
                console.log("Already at last fallback model, applying backoff.");
            }

            if (attempt >= maxAttempts) throw err;

            const backoff = Math.min(30000, 1000 * 2 ** attempt);
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
    if (!shouldProcessOnce(messageId)) return;

    try {
        await bot.sendChatAction(chatId, 'typing');

        if (!chatSessions[chatId]) {
            console.log(`Creating new chat session for chatId: ${chatId}`);
            chatSessions[chatId] = getCurrentModel().startChat({
                history: [
                    { role: "user", parts: [{ text: "Hello, let's have a great conversation." }] },
                    { role: "model", parts: [{ text: systemPrompt }] },
                ],
                generationConfig: { maxOutputTokens: 150 },
            });
        }

        const userChat = chatSessions[chatId];

        const geminiText = await callGeminiWithRetry(async () => {
            const result = await userChat.sendMessage(userMessage);
            const response = await result.response;
            const text = typeof response.text === "function" ? response.text() : response.text;
            return text || "Sorry, I couldn't produce a response.";
        });

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

// --- WEB SERVER FOR WEBHOOKS ---
const app = express();
app.use(express.json());

app.post(`/bot${telegramToken}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (req, res) => {
    res.send('Hello! Your advanced Gemini-powered Telegram bot is alive and using webhooks.');
});

app.listen(port, () => {
    console.log(`Web server running on port ${port}`);
});// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- INITIALIZE APIS ---
console.log("Initializing services...");

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;
const appUrl = process.env.RENDER_EXTERNAL_URL;
const port = process.env.PORT || 3000;

if (!telegramToken || !geminiApiKey) {
    console.error("Missing required environment variables.");
    process.exit(1);
}

// CORRECTED: Initialize bot with polling disabled to use webhooks
const bot = new TelegramBot(telegramToken, { polling: false });

// MODIFICATION: Set the webhook
if (appUrl) {
    bot.setWebhook(`${appUrl}/bot${telegramToken}`);
    console.log(`Webhook set to ${appUrl}/bot${telegramToken}`);
} else {
    console.log("RENDER_EXTERNAL_URL not set. Webhook not configured. Running in local mode?");
}

const genAI = new GoogleGenerativeAI(geminiApiKey);

// --- MODELS ---
const models = [
    "gemini-2.5-flash",
    "gemini-2.5-flashlite",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro"
];
let currentModelIndex = 0;

function getCurrentModel() {
    return genAI.getGenerativeModel({ model: models[currentModelIndex] });
}

// --- SESSION STORAGE ---
const chatSessions = {};
const systemPrompt = "You are ChatGPT 5, a friendly, witty, and highly intelligent AI assistant. Your writing style is natural, engaging, and helpful, like talking to a clever and empathetic friend. You avoid robotic language and excessive markdown formatting. You aim to provide great conversation and accurate information. Keep your answers concise and to the point.";

// --- DEDUPLICATION ---
const processedMsgIds = new Set();
function shouldProcessOnce(messageId) {
    if (!messageId) return true;
    if (processedMsgIds.has(messageId)) return false;
    processedMsgIds.add(messageId);
    setTimeout(() => processedMsgIds.delete(messageId), 6 * 60 * 60 * 1000);
    return true;
}

// --- RATE LIMITER + QUEUE ---
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

// --- GEMINI CALL WITH RETRY + MODEL SWITCH ---
async function callGeminiWithRetry(taskFn, { maxAttempts = 3 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let attempt = 0;

    while (true) {
        try {
            return await limiter(taskFn);
        } catch (err) {
            attempt++;
            const msg = String(err?.message || "");
            const status = err?.status || err?.response?.status || null;
            const is429 = status === 429 || /quota|too many requests|rate limit|rateLimit/i.test(msg);

            if (!is429) throw err;

            console.warn(`Rate limit on model ${models[currentModelIndex]} (attempt ${attempt}).`);

            if (currentModelIndex < models.length - 1) {
                currentModelIndex++;
                console.log(`Switching to fallback model: ${models[currentModelIndex]}`);
            } else {
                console.log("Already at last fallback model, applying backoff.");
            }

            if (attempt >= maxAttempts) throw err;

            const backoff = Math.min(30000, 1000 * 2 ** attempt);
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
    if (!shouldProcessOnce(messageId)) return;

    try {
        await bot.sendChatAction(chatId, 'typing');

        if (!chatSessions[chatId]) {
            console.log(`Creating new chat session for chatId: ${chatId}`);
            chatSessions[chatId] = getCurrentModel().startChat({
                history: [
                    { role: "user", parts: [{ text: "Hello, let's have a great conversation." }] },
                    { role: "model", parts: [{ text: systemPrompt }] },
                ],
                generationConfig: { maxOutputTokens: 150 },
            });
        }

        const userChat = chatSessions[chatId];

        const geminiText = await callGeminiWithRetry(async () => {
            const result = await userChat.sendMessage(userMessage);
            const response = await result.response;
            const text = typeof response.text === "function" ? response.text() : response.text;
            return text || "Sorry, I couldn't produce a response.";
        });

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

// --- WEB SERVER FOR WEBHOOKS ---
const app = express();
app.use(express.json());

app.post(`/bot${telegramToken}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (req, res) => {
    res.send('Hello! Your advanced Gemini-powered Telegram bot is alive and using webhooks.');
});

app.listen(port, () => {
    console.log(`Web server running on port ${port}`);
});

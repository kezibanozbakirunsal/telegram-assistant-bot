const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const http = require("http");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "https://telegram-assistant-bot-4nmx.onrender.com/auth/callback";
const PORT = process.env.PORT || 3000;

const TOKEN_PATH = "/tmp/google_tokens.json";

// OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Token'ları yükle
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
      oauth2Client.setCredentials(tokens);
      return true;
    }
  } catch (e) {
    console.error("Token yüklenemedi:", e);
  }
  return false;
}

// Token'ları kaydet
function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
}

// Auth URL oluştur
function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar",
    ],
    prompt: "consent",
  });
}

// Gmail - son mailler
async function getRecentEmails(maxResults = 5) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    labelIds: ["INBOX"],
  });

  if (!res.data.messages) return "📭 Gelen kutunuz boş.";

  const emails = [];
  for (const msg of res.data.messages.slice(0, maxResults)) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = detail.data.payload.headers;
    const subject = headers.find((h) => h.name === "Subject")?.value || "(Konu yok)";
    const from = headers.find((h) => h.name === "From")?.value || "Bilinmiyor";
    const date = headers.find((h) => h.name === "Date")?.value || "";
    emails.push(`📧 *${subject}*\n👤 ${from}\n📅 ${date}`);
  }
  return emails.join("\n\n---\n\n");
}

// Gmail - mail gönder
async function sendEmail(to, subject, body) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const message = [`To: ${to}`, `Subject: ${subject}`, "", body].join("\n");
  const encoded = Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
}

// Calendar - bugünün etkinlikleri
async function getTodayEvents() {
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  if (!res.data.items?.length) return "📅 Bugün etkinlik yok.";

  return res.data.items
    .map((e) => {
      const start = e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        : "Tüm gün";
      return `📅 *${e.summary}* - ${start}`;
    })
    .join("\n");
}

// Claude ile konuş
async function askClaude(userMessage, gmailData, calendarData) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `Sen yardımcı bir kişisel asistansın. Türkçe cevap ver. Kısa ve net ol.
${gmailData ? `\nGüncel mailler:\n${gmailData}` : ""}
${calendarData ? `\nBugünün takvimi:\n${calendarData}` : ""}`,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await response.json();
  return data.content?.[0]?.text || "Cevap alınamadı.";
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/auth/callback") {
    const code = url.searchParams.get("code");
    if (code) {
      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        saveTokens(tokens);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>✅ Yetkilendirme başarılı! Telegram botuna dönebilirsiniz.</h1>");
        console.log("✅ Google token alındı!");
      } catch (e) {
        res.writeHead(500);
        res.end("Hata: " + e.message);
      }
    }
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot çalışıyor!");
  }
});

server.listen(PORT, () => console.log(`HTTP server port ${PORT}'de çalışıyor`));

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
loadTokens();

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;

  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    bot.sendMessage(chatId, "⛔ Erişim izniniz yok.");
    return;
  }

  if (!text) return;

  if (text === "/start") {
    const isAuth = loadTokens();
    if (!isAuth) {
      const authUrl = getAuthUrl();
      bot.sendMessage(chatId, `👋 Merhaba! Önce Google hesabını bağlaman gerekiyor:\n\n${authUrl}`);
    } else {
      bot.sendMessage(chatId, `👋 Merhaba! Hazırım.\n\n📧 "maillerimi göster"\n📅 "bugün ne var takvimde"\n✉️ "mail at: kime@email.com | konu | mesaj"`);
    }
    return;
  }

  if (text === "/auth") {
    const authUrl = getAuthUrl();
    bot.sendMessage(chatId, `Google hesabını bağlamak için:\n\n${authUrl}`);
    return;
  }

  const isAuth = loadTokens();
  if (!isAuth) {
    bot.sendMessage(chatId, `⚠️ Önce Google hesabını bağla: /auth`);
    return;
  }

  bot.sendChatAction(chatId, "typing");

  try {
    let gmailData = null;
    let calendarData = null;
    let reply = "";

    const lowerText = text.toLowerCase();

    // Mail gönder
    if (lowerText.includes("mail at") || lowerText.includes("mail gönder")) {
      const parts = text.split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        const to = parts[0].replace(/.*?:/i, "").trim();
        const subject = parts[1];
        const body = parts[2];
        await sendEmail(to, subject, body);
        reply = `✅ Mail gönderildi!\n📧 Alıcı: ${to}\n📝 Konu: ${subject}`;
      } else {
        reply = "Mail göndermek için şu formatı kullan:\nmail at: kime@email.com | konu | mesaj";
      }
    }
    // Mailler
    else if (lowerText.includes("mail") || lowerText.includes("e-posta") || lowerText.includes("inbox")) {
      gmailData = await getRecentEmails(5);
      reply = gmailData;
    }
    // Takvim
    else if (lowerText.includes("takvim") || lowerText.includes("etkinlik") || lowerText.includes("bugün ne var")) {
      calendarData = await getTodayEvents();
      reply = calendarData;
    }
    // Genel soru - Claude'a sor
    else {
      reply = await askClaude(text, null, null);
    }

    if (reply.length > 4096) {
      const chunks = reply.match(/.{1,4096}/gs);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Hata:", err);
    bot.sendMessage(chatId, "❌ Hata: " + err.message);
  }
});

console.log("🤖 Bot başlatıldı!");

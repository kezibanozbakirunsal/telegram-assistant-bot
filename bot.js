const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const PORT = process.env.PORT || 3000;

// OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  "urn:ietf:wg:oauth:2.0:oob"
);

// Refresh token'i direkt kullan
if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  console.log("Google refresh token yuklendi!");
}

// Gmail - son mailler
async function getRecentEmails(maxResults = 5) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    labelIds: ["INBOX"],
  });

  if (!res.data.messages) return "Gelen kutunuz bos.";

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
    emails.push(`*${subject}*\nGonderen: ${from}\nTarih: ${date}`);
  }
  return emails.join("\n\n---\n\n");
}

// Gmail - mail gonder
async function sendEmail(to, subject, body) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const message = [`To: ${to}`, `Subject: ${subject}`, "", body].join("\n");
  const encoded = Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
}

// Calendar - bugunun etkinlikleri
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

  if (!res.data.items?.length) return "Bugun etkinlik yok.";

  return res.data.items
    .map((e) => {
      const start = e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        : "Tum gun";
      return `*${e.summary}* - ${start}`;
    })
    .join("\n");
}

// Claude ile konus
async function askClaude(userMessage) {
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
      system: "Sen yardimci bir kisisel asistansin. Turkce cevap ver. Kisa ve net ol.",
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await response.json();
  return data.content?.[0]?.text || "Cevap alinamadi.";
}

// HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot calisiyor!");
});
server.listen(PORT, () => console.log(`HTTP server port ${PORT} de calisiyor`));

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;

  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    bot.sendMessage(chatId, "Erisim izniniz yok.");
    return;
  }

  if (!text) return;

  if (text === "/start") {
    bot.sendMessage(chatId, "Merhaba! Hazirim.\n\n- 'maillerimi goster'\n- 'bugun takvimde ne var'\n- 'mail at: kime@email.com | konu | mesaj'");
    return;
  }

  bot.sendChatAction(chatId, "typing");

  try {
    let reply = "";
    const lowerText = text.toLowerCase();

    if (lowerText.includes("mail at") || lowerText.includes("mail gonder")) {
      const parts = text.split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        const to = parts[0].replace(/.*?:/i, "").trim();
        const subject = parts[1];
        const body = parts[2];
        await sendEmail(to, subject, body);
        reply = `Mail gonderildi!\nAlici: ${to}\nKonu: ${subject}`;
      } else {
        reply = "Format: mail at: kime@email.com | konu | mesaj";
      }
    } else if (lowerText.includes("mail") || lowerText.includes("e-posta") || lowerText.includes("inbox")) {
      reply = await getRecentEmails(5);
    } else if (lowerText.includes("takvim") || lowerText.includes("etkinlik") || lowerText.includes("bugun ne var")) {
      reply = await getTodayEvents();
    } else {
      reply = await askClaude(text);
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
    bot.sendMessage(chatId, "Hata: " + err.message);
  }
});

console.log("Bot baslatildi!");

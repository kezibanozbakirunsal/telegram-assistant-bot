const TelegramBot = require("node-telegram-bot-api");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;

// Render'ın port kontrolü için basit HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!");
});
server.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; // Güvenlik için sadece sen kullanabilirsin

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Her kullanıcı için konuşma geçmişi
const conversations = {};

async function askClaude(userMessage, userId) {
  if (!conversations[userId]) {
    conversations[userId] = [];
  }

  conversations[userId].push({
    role: "user",
    content: userMessage,
  });

  // Son 20 mesajı tut (context window için)
  if (conversations[userId].length > 20) {
    conversations[userId] = conversations[userId].slice(-20);
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: `Sen yardımcı bir kişisel asistansın. Kullanıcının Gmail ve Google Calendar'ına erişimin var.
- Mail okuyabilir, arayabilir, gönderebilirsin
- Takvim etkinliklerini görebilir ve oluşturabilirsin
- Türkçe cevap ver
- Kısa ve net ol
- Bugünün tarihi: ${new Date().toLocaleDateString("tr-TR")}`,
      messages: conversations[userId],
      mcp_servers: [
        {
          type: "url",
          url: "https://gmail.mcp.claude.com/mcp",
          name: "gmail",
        },
        {
          type: "url",
          url: "https://gcal.mcp.claude.com/mcp",
          name: "google-calendar",
        },
      ],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "API hatası");
  }

  // Tüm text bloklarını birleştir
  const reply = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  // Asistan cevabını geçmişe ekle
  conversations[userId].push({
    role: "assistant",
    content: reply,
  });

  return reply;
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;

  // Güvenlik kontrolü - sadece izin verilen kullanıcı
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    bot.sendMessage(chatId, "⛔ Bu bota erişim izniniz yok.");
    return;
  }

  if (!text) return;

  // /start komutu
  if (text === "/start") {
    bot.sendMessage(
      chatId,
      `👋 Merhaba! Ben senin kişisel asistanınım.\n\n` +
        `📧 Mail okuyabilir, gönderebilir\n` +
        `📅 Takvimini yönetebilirim\n\n` +
        `Örnek sorular:\n` +
        `• "Son maillerimi göster"\n` +
        `• "Bugün takvimde ne var"\n` +
        `• "Ali'ye mail at: toplantı saat 3'te"\n` +
        `• "Yarın sabah 10'a toplantı ekle"\n\n` +
        `/temizle - Konuşmayı sıfırla`
    );
    return;
  }

  // /temizle komutu
  if (text === "/temizle") {
    conversations[userId] = [];
    bot.sendMessage(chatId, "🗑️ Konuşma geçmişi temizlendi.");
    return;
  }

  // Yazıyor... göster
  bot.sendChatAction(chatId, "typing");

  try {
    const reply = await askClaude(text, userId);
    
    // Telegram mesaj limiti 4096 karakter
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
    bot.sendMessage(
      chatId,
      "❌ Bir hata oluştu: " + (err.message || "Bilinmeyen hata")
    );
  }
});

console.log("🤖 Bot başlatıldı...");

# IELTS ZONE — Tasks bot (Notion → Telegram)

Notion'da sizga berilgan tasklar Telegram'ga keladi. Bot **Cloudflare Workers**'ning bepul tarifida ishlaydi, shuning uchun noutbuk o'chiq yoki internetsiz bo'lsa ham 24/7 ishlayveradi.

## Bot nima qiladi

- 🆕 Sizga yangi task berilsa, Telegram'ga **to'liq mazmuni** bilan keladi: sarlavha, deadline, status, kim bergani, barcha ustunlar va sahifa ichidagi matn, checklist, rasm va fayllar.
- ▶️ **Boshladim** tugmasi ishni boshlaganingizda Notion'da statusni `In progress` qiladi. Shundan keyin tugma **✅ Bajarildi** ga almashadi.
- ✅ **Bajarildi** tugmasi (tasdiqlash bilan) quyidagilarni qiladi:
  - Notion'da statusni `Done` qiladi.
  - Task bergan odamni izohda **@mention** qiladi, shunda unga Notion'da notification boradi.
- ⏰ **Deadline eslatmalari** keladi: muddatga 24 soat va 3 soat qolganda, hamda muddat o'tib ketganda.
- ☀️ Har kuni **09:00** da (Toshkent vaqti) xulosa keladi: muddati o'tgan, bugungi va ertangi tasklar.
- 🔒 Botni faqat `ALLOWED_TELEGRAM_IDS` ro'yxatidagi odamlar ishlata oladi.

Buyruqlar: `/tasks` (barcha faol tasklar), `/today` (bugungi xulosa), `/users` (Notion foydalanuvchilari ID'lari), `/help`.

## O'rnatish (faqat brauzer orqali, terminal kerak emas)

### 1. Telegram bot
[@BotFather](https://t.me/BotFather) orqali `/newbot` buyrug'ini yuboring va tokenni oling. Eski botingiz bo'lsa, uning tokeni ham ishlaydi.

### 2. Notion integratsiya
1. https://www.notion.so/my-integrations sahifasida **New integration** yarating va **Internal Integration Secret**'ni oling.
2. **Capabilities** bo'limida quyidagilarni yoqing:
   - Read content
   - Update content
   - Read comments
   - **Insert comments** (task bergan odamga xabar borishi uchun shart)
   - Read user information
3. IELTS ZONE'dagi **Tasks** bazasini oching, `•••` → **Connections** orqali integratsiyani qo'shing.
4. Bazani **↗** tugmasi bilan to'liq sahifada oching. Linkdagi `?v=` dan oldingi 32 ta belgi baza ID'si bo'ladi.

### 3. Cloudflare Worker
1. https://dash.cloudflare.com sahifasida **Workers & Pages** → **Create** → **Start with Hello World** → **Deploy** qiling.
2. **Edit code** ni bosing, eski kodni o'chiring, `worker.js` ni to'liq nusxalab qo'ying va **Deploy** qiling.
3. **Settings → Variables and Secrets** bo'limiga quyidagilarni qo'shing:

| Nomi | Turi | Qiymati |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | BotFather bergan token |
| `NOTION_TOKEN` | Secret | Notion integratsiya secret'i |
| `NOTION_DATABASE_ID` | Text | Tasks bazasi ID'si |
| `ALLOWED_TELEGRAM_IDS` | Text | 4-qadamda olinadi |
| `NOTION_USER_ID` | Text | 4-qadamda olinadi |

4. **Storage & Databases → KV → Create** orqali KV yarating (nomi ixtiyoriy). Keyin worker'da **Settings → Bindings → Add → KV namespace** ni tanlab, **Variable name** ga `KV` deb yozing.
5. **Settings → Trigger events → Cron Triggers** bo'limiga ikkita trigger qo'shing:
   - `*/5 * * * *`: har 5 daqiqada yangi tasklar va deadline'larni tekshiradi.
   - `0 4 * * *`: ertalabki xulosa (UTC 04:00 = Toshkent 09:00).
6. Brauzerda `https://<worker-nomi>.<akkaunt>.workers.dev/setup` ni oching. Hamma qator ✅ bo'lishi kerak.

### 4. Ruxsat va ID'lar
1. Botga `/start` yozing. Bot Telegram ID'ingizni ko'rsatadi, uni `ALLOWED_TELEGRAM_IDS` ga yozing. Bir nechta odam bo'lsa, ID'larni vergul bilan ajrating.
2. Botga `/users` yozing, ro'yxatdan o'zingizni toping va ID'ni `NOTION_USER_ID` ga yozing.
3. Bir necha daqiqadan keyin botdan "🤖 Bot ulandi!" degan xabar keladi. Shundan boshlab yangi tasklar avtomatik keladi.

## Qo'shimcha sozlamalar (ixtiyoriy)

| O'zgaruvchi | Standart qiymat | Ma'nosi |
|---|---|---|
| `PROP_STATUS` | `Status` | Status ustuni nomi (Status yoki Select turi) |
| `PROP_ASSIGNEE` | `Assignee` | Kimga berilgani (Person turi) |
| `PROP_DUE` | `Due date` | Deadline ustuni (Date turi) |
| `PROP_REPORTER` | — | Task bergan odam ustuni (Person). Bo'sh qolsa, sahifani yaratgan odam olinadi |
| `STATUS_DONE` | `Done` | "Bajarildi" holatining nomi |
| `STATUS_PROGRESS` | `In progress` | "Jarayonda" holatining nomi |
| `REMIND_HOURS` | `24,3` | Deadline'dan necha soat oldin eslatish kerakligi |
| `DEFAULT_DUE_TIME` | `18:00` | Deadline'da faqat sana bo'lsa, shu vaqt muddat deb hisoblanadi |
| `TIMEZONE` | `Asia/Tashkent` | Vaqt mintaqasi |

## Bepul tarif cheklovlari

Cloudflare bepul tarifida kuniga 100 000 so'rov va 1 000 ta KV yozish mumkin. Bu bot kuniga taxminan 300 ta tekshiruv qiladi, shuning uchun limitlar bemalol yetadi. Karta talab qilinmaydi.

## Avtomatik yangilanish (Workers Builds)

Worker GitHub'ga ulangan bo'lsa, `claude/modest-cray-l8kziv` branchiga har bir push qilinganda Cloudflare kodni o'zi yangilaydi. Sozlamalar `wrangler.jsonc` faylida: worker nomi, KV va cron'lar. Tokenlar va Text o'zgaruvchilar dashboard'da qoladi (`keep_vars`).

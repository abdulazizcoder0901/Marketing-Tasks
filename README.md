# Marketing Tasks — Notion ↔ Telegram bot

Notion'da sizga biriktirilgan tasklarni Telegram botda ko'rish va boshqarish.

## Imkoniyatlar

- `/tasks` — sizga biriktirilgan barcha faol tasklar
- `/today` — bugungi va muddati o'tgan tasklar
- `/week` — yaqin 7 kundagi tasklar
- `/new Nomi | 2026-10-20` — yangi task yaratish (sana ixtiyoriy)
- `/users` — Notion foydalanuvchilari va ID'lari
- Task kartochkasidagi tugmalar: statusni o'zgartirish, muddatni qo'yish
  (bugun / ertaga / +1 hafta), Notion'ga izoh yozish, Notion'da ochish
- Sizga yangi task biriktirilsa — darhol xabar keladi
- Har kuni ertalab (standart 09:00) bugungi tasklar xulosasi

## Sozlash

### 1. Telegram bot
[@BotFather](https://t.me/BotFather) → `/newbot` → tokenni oling.

### 2. Notion integratsiya
1. https://www.notion.so/my-integrations → **New integration** → secret'ni oling.
2. Notion'dagi tasklar bazasini oching → `•••` → **Connections** → integratsiyangizni qo'shing.
3. IELTS ZONE sahifasidagi **Tasks** jadvalini **↗** bilan to'liq ochib, linkdan ID'ni oling: `notion.so/`**`1a2b3c...`**`?v=...`

Bazada quyidagi ustunlar bo'lishi kerak (nomlarini `.env` da o'zgartirish mumkin):

| Ustun | Turi | `.env` |
|---|---|---|
| Task nomi | Title | avtomatik aniqlanadi |
| Status | Status yoki Select | `PROP_STATUS` |
| Assignee | Person | `PROP_ASSIGNEE` |
| Due date | Date | `PROP_DUE` |

### 3. Ishga tushirish
```bash
pip install -r requirements.txt
cp .env.example .env    # va qiymatlarni to'ldiring
python bot.py
```

Birinchi marta:
1. Botga `/start` yozing — u Telegram ID'ingizni ko'rsatadi → `ALLOWED_TELEGRAM_IDS` ga yozing.
2. `/users` yozing — ro'yxatdan o'zingizni toping → ID'ni `NOTION_USER_ID` ga yozing.
3. Botni qayta ishga tushiring va `/start` ni yana bosing.

Bot 24/7 ishlashi uchun uni server/VPS'da (yoki Railway, Render kabi xizmatlarda) ishga tushiring.

## Terminalsiz ishga tushirish (Railway)

1. https://railway.com/new/github → GitHub bilan kiring → `Marketing-Tasks` reposini tanlang.
2. Servis ochilgach **Variables** → **Raw Editor** ga `.env.example` dagi qiymatlarni to'ldirib qo'ying → **Deploy**.
3. **Deployments → View logs** da `Notion bazasi ulandi` chiqsa, bot ishlayapti.

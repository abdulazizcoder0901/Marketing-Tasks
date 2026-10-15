"""Notion tasklarini Telegram orqali ko'rish va boshqarish boti."""

from __future__ import annotations

import html
import json
import logging
import os
from datetime import date, datetime, time, timedelta
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from notion import Notion, NotionError, Task

load_dotenv()
logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO)
log = logging.getLogger("bot")

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ALLOWED_IDS = {int(x) for x in os.getenv("ALLOWED_TELEGRAM_IDS", "").replace(" ", "").split(",") if x}
NOTION_USER_ID = os.getenv("NOTION_USER_ID", "").strip()
TZ = ZoneInfo(os.getenv("TIMEZONE", "Asia/Tashkent"))
POLL_MINUTES = int(os.getenv("POLL_MINUTES", "5"))
DIGEST_TIME = os.getenv("DIGEST_TIME", "09:00").strip()
STATE_FILE = Path(os.getenv("STATE_FILE", "state.json"))

notion = Notion(
    token=os.environ["NOTION_TOKEN"],
    database_id=os.environ["NOTION_DATABASE_ID"],
    prop_status=os.getenv("PROP_STATUS", "Status"),
    prop_assignee=os.getenv("PROP_ASSIGNEE", "Assignee"),
    prop_due=os.getenv("PROP_DUE", "Due date"),
    status_done=os.getenv("STATUS_DONE", "Done"),
)

# Izoh yozish kutilayotgan task: {chat_id: page_id}
awaiting_comment: dict[int, str] = {}


# ---------- yordamchi funksiyalar ----------

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"seen": [], "chats": []}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state))


def notify_chats(state: dict) -> set[int]:
    # Xostingda fayl qayta ishga tushganda o'chib ketishi mumkin, shuning uchun
    # ruxsat berilgan foydalanuvchilarga (shaxsiy chat ID = user ID) doim yuboramiz.
    return set(state["chats"]) | ALLOWED_IDS


def today() -> date:
    return datetime.now(TZ).date()


def due_label(task: Task) -> str:
    if not task.due:
        return ""
    delta = (task.due - today()).days
    if delta < 0:
        return f"🔴 {task.due:%d.%m} (muddati o'tgan)"
    if delta == 0:
        return "🟠 bugun"
    if delta == 1:
        return "🟡 ertaga"
    return f"📅 {task.due:%d.%m}"


def task_line(task: Task) -> str:
    parts = [f"• <b>{html.escape(task.title)}</b>"]
    if task.status:
        parts.append(f"[{html.escape(task.status)}]")
    if task.due:
        parts.append(due_label(task))
    return " ".join(parts)


def task_card(task: Task) -> tuple[str, InlineKeyboardMarkup]:
    text = (
        f"📝 <b>{html.escape(task.title)}</b>\n\n"
        f"Status: <b>{html.escape(task.status or '—')}</b>\n"
        f"Muddat: {due_label(task) or '—'}"
    )
    status_buttons = [
        InlineKeyboardButton(("✅ " if s == task.status else "") + s, callback_data=f"s:{task.id}:{i}")
        for i, s in enumerate(notion.status_options)
    ]
    rows = [status_buttons[i:i + 3] for i in range(0, len(status_buttons), 3)]
    rows.append([
        InlineKeyboardButton("📅 Bugun", callback_data=f"d:{task.id}:0"),
        InlineKeyboardButton("📅 Ertaga", callback_data=f"d:{task.id}:1"),
        InlineKeyboardButton("📅 +1 hafta", callback_data=f"d:{task.id}:7"),
    ])
    rows.append([
        InlineKeyboardButton("💬 Izoh", callback_data=f"c:{task.id}"),
        InlineKeyboardButton("🔗 Notion", url=task.url),
    ])
    rows.append([InlineKeyboardButton("⬅️ Ro'yxatga", callback_data="list")])
    return text, InlineKeyboardMarkup(rows)


def list_view(tasks: list[Task], title: str) -> tuple[str, InlineKeyboardMarkup | None]:
    if not tasks:
        return f"{title}\n\nHech narsa yo'q 🎉", None
    text = f"{title} ({len(tasks)})\n\n" + "\n".join(task_line(t) for t in tasks)
    buttons = [[InlineKeyboardButton(t.title[:60], callback_data=f"t:{t.id}")] for t in tasks[:50]]
    return text, InlineKeyboardMarkup(buttons)


def authorized(handler):
    @wraps(handler)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user = update.effective_user
        if ALLOWED_IDS and (not user or user.id not in ALLOWED_IDS):
            if update.callback_query:
                await update.callback_query.answer("Ruxsat yo'q", show_alert=True)
            elif update.effective_message:
                await update.effective_message.reply_text("⛔ Bu bot shaxsiy.")
            return
        try:
            return await handler(update, context)
        except NotionError as e:
            log.warning("Notion xatosi: %s", e)
            await update.effective_chat.send_message(f"⚠️ {e}")
    return wrapper


def require_user_id() -> str | None:
    return None if NOTION_USER_ID else (
        "NOTION_USER_ID sozlanmagan. /users buyrug'i bilan ID'ingizni toping "
        "va .env fayliga yozing."
    )


# ---------- buyruqlar ----------

@authorized
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state = load_state()
    chat_id = update.effective_chat.id
    if chat_id not in state["chats"]:
        state["chats"].append(chat_id)
        save_state(state)
    text = (
        "Salom! Men Notion'dagi tasklaringizni boshqaraman.\n\n"
        "/tasks — barcha faol tasklarim\n"
        "/today — bugungi va muddati o'tganlar\n"
        "/week — shu haftadagilar\n"
        "/new Nomi | 2026-10-20 — yangi task (sana ixtiyoriy)\n"
        "/users — Notion foydalanuvchilari va ID'lari\n\n"
        "Yangi task biriktirilsa, darhol xabar beraman."
    )
    if not ALLOWED_IDS:
        text += (
            f"\n\n⚠️ Sizning Telegram ID: <code>{update.effective_user.id}</code>\n"
            "Uni .env dagi ALLOWED_TELEGRAM_IDS ga yozing, shunda botdan faqat siz foydalanasiz."
        )
    if err := require_user_id():
        text += f"\n\n⚠️ {err}"
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


async def _send_list(update: Update, title: str, predicate=lambda t: True):
    if err := require_user_id():
        await update.message.reply_text(err)
        return
    tasks = [t for t in await notion.my_tasks(NOTION_USER_ID) if predicate(t)]
    text, kb = list_view(tasks, title)
    await update.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=kb)


@authorized
async def cmd_tasks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await _send_list(update, "📋 <b>Faol tasklarim</b>")


@authorized
async def cmd_today(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await _send_list(update, "🔥 <b>Bugun va muddati o'tgan</b>",
                     lambda t: t.due is not None and t.due <= today())


@authorized
async def cmd_week(update: Update, context: ContextTypes.DEFAULT_TYPE):
    limit = today() + timedelta(days=7)
    await _send_list(update, "🗓 <b>Yaqin 7 kun</b>",
                     lambda t: t.due is not None and t.due <= limit)


@authorized
async def cmd_new(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if err := require_user_id():
        await update.message.reply_text(err)
        return
    raw = update.message.text.partition(" ")[2].strip()
    if not raw:
        await update.message.reply_text("Foydalanish: /new Task nomi | 2026-10-20")
        return
    title, _, due_raw = (p.strip() for p in raw.partition("|"))
    due = None
    if due_raw:
        try:
            due = date.fromisoformat(due_raw)
        except ValueError:
            await update.message.reply_text("Sana formati: YYYY-MM-DD (masalan 2026-10-20)")
            return
    task = await notion.create_task(title, NOTION_USER_ID, due)
    state = load_state()
    state["seen"].append(task.id)
    save_state(state)
    text, kb = task_card(task)
    await update.message.reply_text("✅ Yaratildi\n\n" + text, parse_mode=ParseMode.HTML, reply_markup=kb)


@authorized
async def cmd_users(update: Update, context: ContextTypes.DEFAULT_TYPE):
    users = await notion.list_users()
    lines = [f"{html.escape(u.get('name') or '?')}: <code>{u['id']}</code>" for u in users]
    await update.message.reply_text(
        "👥 Notion foydalanuvchilari:\n\n" + ("\n".join(lines) or "topilmadi"),
        parse_mode=ParseMode.HTML,
    )


@authorized
async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    page_id = awaiting_comment.pop(update.effective_chat.id, None)
    if not page_id:
        await update.message.reply_text("Buyruqlar ro'yxati: /start")
        return
    await notion.add_comment(page_id, update.message.text)
    await update.message.reply_text("💬 Izoh Notion'ga qo'shildi.")


# ---------- tugmalar ----------

@authorized
async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    kind, _, rest = data.partition(":")

    if kind == "list":
        await query.answer()
        tasks = await notion.my_tasks(NOTION_USER_ID)
        text, kb = list_view(tasks, "📋 <b>Faol tasklarim</b>")
        await query.edit_message_text(text, parse_mode=ParseMode.HTML, reply_markup=kb)
        return

    if kind == "t":
        task = await notion.get_task(rest)
        await query.answer()
    elif kind == "s":
        page_id, _, idx = rest.partition(":")
        status = notion.status_options[int(idx)]
        task = await notion.set_status(page_id, status)
        await query.answer(f"Status: {status}")
    elif kind == "d":
        page_id, _, days = rest.partition(":")
        task = await notion.set_due(page_id, today() + timedelta(days=int(days)))
        await query.answer("Muddat yangilandi")
    elif kind == "c":
        awaiting_comment[query.message.chat_id] = rest
        await query.answer()
        await query.message.reply_text("Izoh matnini yozing:")
        return
    else:
        await query.answer()
        return

    text, kb = task_card(task)
    await query.edit_message_text(text, parse_mode=ParseMode.HTML, reply_markup=kb)


# ---------- fon vazifalari ----------

async def job_check_new(context: ContextTypes.DEFAULT_TYPE):
    """Yangi biriktirilgan tasklar haqida xabar beradi."""
    if not NOTION_USER_ID:
        return
    state = load_state()
    try:
        tasks = await notion.my_tasks(NOTION_USER_ID, include_done=True)
    except Exception:
        log.exception("Tasklarni olishda xato")
        return
    seen = set(state["seen"])
    first_run = not state.get("initialized")
    new = [t for t in tasks if t.id not in seen]
    state["seen"] = list(seen | {t.id for t in tasks})
    state["initialized"] = True
    save_state(state)
    if first_run:
        return  # birinchi ishga tushishda eski tasklarni "yangi" deb yubormaymiz
    for task in new:
        if task.status == notion.status_done:
            continue
        text, kb = task_card(task)
        for chat_id in notify_chats(state):
            await context.bot.send_message(chat_id, "🆕 Sizga yangi task biriktirildi!\n\n" + text,
                                           parse_mode=ParseMode.HTML, reply_markup=kb)


async def job_digest(context: ContextTypes.DEFAULT_TYPE):
    """Har kuni ertalab bugungi va muddati o'tgan tasklar."""
    if not NOTION_USER_ID:
        return
    state = load_state()
    tasks = await notion.my_tasks(NOTION_USER_ID)
    urgent = [t for t in tasks if t.due and t.due <= today()]
    text, kb = list_view(urgent, f"☀️ <b>Xayrli tong!</b> Faol tasklar: {len(tasks)}\n🔥 <b>Bugungi</b>")
    for chat_id in notify_chats(state):
        await context.bot.send_message(chat_id, text, parse_mode=ParseMode.HTML, reply_markup=kb)


async def post_init(app: Application):
    await notion.load_schema()
    log.info("Notion bazasi ulandi. Statuslar: %s", notion.status_options)
    app.job_queue.run_repeating(job_check_new, interval=POLL_MINUTES * 60, first=5)
    if DIGEST_TIME:
        hh, mm = map(int, DIGEST_TIME.split(":"))
        app.job_queue.run_daily(job_digest, time=time(hh, mm, tzinfo=TZ))


async def post_shutdown(app: Application):
    await notion.close()


def main():
    app = Application.builder().token(TOKEN).post_init(post_init).post_shutdown(post_shutdown).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("tasks", cmd_tasks))
    app.add_handler(CommandHandler("today", cmd_today))
    app.add_handler(CommandHandler("week", cmd_week))
    app.add_handler(CommandHandler("new", cmd_new))
    app.add_handler(CommandHandler("users", cmd_users))
    app.add_handler(CallbackQueryHandler(on_button))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.run_polling()


if __name__ == "__main__":
    main()

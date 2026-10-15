// Notion tasklarini Telegram orqali boshqarish boti — Cloudflare Workers versiyasi (bepul).
// Butun fayl Cloudflare dashboard'idagi kod muharririga nusxalab qo'yiladi.

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ---------- sozlamalar ----------

function cfg(env) {
  return {
    db: (env.NOTION_DATABASE_ID || "").replace(/-/g, "").trim(),
    user: (env.NOTION_USER_ID || "").trim(),
    status: env.PROP_STATUS || "Status",
    assignee: env.PROP_ASSIGNEE || "Assignee",
    due: env.PROP_DUE || "Due date",
    done: env.STATUS_DONE || "Done",
    tz: env.TIMEZONE || "Asia/Tashkent",
    allowed: (env.ALLOWED_TELEGRAM_IDS || "")
      .split(",").map((s) => s.trim()).filter(Boolean).map(Number),
  };
}

// ---------- Notion ----------

async function notion(env, method, path, body) {
  const resp = await fetch(NOTION_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Notion ${resp.status}: ${data.message || "xato"}`);
  return data;
}

let schemaCache = null;

async function schema(env) {
  if (schemaCache) return schemaCache;
  const c = cfg(env);
  const db = await notion(env, "GET", `/databases/${c.db}`);
  const props = db.properties;
  for (const name of [c.status, c.assignee, c.due]) {
    if (!props[name]) {
      throw new Error(`Bazada '${name}' ustuni topilmadi. Mavjud ustunlar: ${Object.keys(props).join(", ")}`);
    }
  }
  const st = props[c.status];
  if (st.type !== "status" && st.type !== "select") {
    throw new Error(`'${c.status}' ustuni status yoki select bo'lishi kerak`);
  }
  schemaCache = {
    title: Object.keys(props).find((k) => props[k].type === "title"),
    statusType: st.type,
    options: st[st.type].options.map((o) => o.name),
  };
  return schemaCache;
}

function parseTask(env, s, page) {
  const c = cfg(env);
  const p = page.properties;
  const title = (p[s.title]?.title || []).map((t) => t.plain_text).join("") || "(nomsiz)";
  const status = p[c.status]?.[s.statusType]?.name || null;
  const due = p[c.due]?.date?.start?.slice(0, 10) || null;
  return { id: page.id.replace(/-/g, ""), title, status, due, url: page.url };
}

async function myTasks(env, includeDone = false) {
  const c = cfg(env);
  const s = await schema(env);
  const and = [{ property: c.assignee, people: { contains: c.user } }];
  if (!includeDone) and.push({ property: c.status, [s.statusType]: { does_not_equal: c.done } });
  const body = { filter: { and }, sorts: [{ property: c.due, direction: "ascending" }], page_size: 100 };
  const tasks = [];
  for (;;) {
    const data = await notion(env, "POST", `/databases/${c.db}/query`, body);
    tasks.push(...data.results.map((pg) => parseTask(env, s, pg)));
    if (!data.has_more) return tasks;
    body.start_cursor = data.next_cursor;
  }
}

async function getTask(env, id) {
  return parseTask(env, await schema(env), await notion(env, "GET", `/pages/${id}`));
}

async function updateTask(env, id, properties) {
  return parseTask(env, await schema(env), await notion(env, "PATCH", `/pages/${id}`, { properties }));
}

async function createTask(env, title, due) {
  const c = cfg(env);
  const s = await schema(env);
  const properties = {
    [s.title]: { title: [{ text: { content: title } }] },
    [c.assignee]: { people: [{ id: c.user }] },
  };
  if (s.options.length) properties[c.status] = { [s.statusType]: { name: s.options[0] } };
  if (due) properties[c.due] = { date: { start: due } };
  const page = await notion(env, "POST", "/pages", { parent: { database_id: c.db }, properties });
  return parseTask(env, s, page);
}

// ---------- sana ----------

function today(env) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: cfg(env).tz }).format(new Date());
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dueLabel(env, task) {
  if (!task.due) return "";
  const t = today(env);
  const [, m, d] = task.due.split("-");
  if (task.due < t) return `🔴 ${d}.${m} (muddati o'tgan)`;
  if (task.due === t) return "🟠 bugun";
  if (task.due === addDays(t, 1)) return "🟡 ertaga";
  return `📅 ${d}.${m}`;
}

// ---------- Telegram ----------

async function tg(env, method, payload) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!data.ok && !String(data.description).includes("message is not modified")) {
    console.log("Telegram xatosi", method, data.description);
  }
  return data;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function send(env, chatId, text, keyboard) {
  return tg(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

function taskLine(env, t) {
  let line = `• <b>${esc(t.title)}</b>`;
  if (t.status) line += ` [${esc(t.status)}]`;
  if (t.due) line += ` ${dueLabel(env, t)}`;
  return line;
}

async function taskCard(env, t) {
  const s = await schema(env);
  const text =
    `📝 <b>${esc(t.title)}</b>\n\n` +
    `Status: <b>${esc(t.status || "—")}</b>\n` +
    `Muddat: ${dueLabel(env, t) || "—"}`;
  const statusBtns = s.options.map((name, i) => ({
    text: (name === t.status ? "✅ " : "") + name, callback_data: `s:${t.id}:${i}`,
  }));
  const kb = [];
  for (let i = 0; i < statusBtns.length; i += 3) kb.push(statusBtns.slice(i, i + 3));
  kb.push([
    { text: "📅 Bugun", callback_data: `d:${t.id}:0` },
    { text: "📅 Ertaga", callback_data: `d:${t.id}:1` },
    { text: "📅 +1 hafta", callback_data: `d:${t.id}:7` },
  ]);
  kb.push([
    { text: "💬 Izoh", callback_data: `c:${t.id}` },
    { text: "🔗 Notion", url: t.url },
  ]);
  kb.push([{ text: "⬅️ Ro'yxatga", callback_data: "list" }]);
  return { text, kb };
}

function listView(env, tasks, title) {
  if (!tasks.length) return { text: `${title}\n\nHech narsa yo'q 🎉`, kb: undefined };
  let text = `${title} (${tasks.length})\n\n` + tasks.map((t) => taskLine(env, t)).join("\n");
  if (text.length > 4000) text = text.slice(0, 3990) + "\n…";
  const kb = tasks.slice(0, 50).map((t) => [{ text: t.title.slice(0, 60), callback_data: `t:${t.id}` }]);
  return { text, kb };
}

const NEED_USER =
  "NOTION_USER_ID sozlanmagan. /users buyrug'i bilan ID'ingizni toping va Cloudflare'dagi Variables bo'limiga yozing.";

// ---------- buyruqlar ----------

async function onMessage(env, msg) {
  const c = cfg(env);
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Izoh: "💬 Izoh" tugmasidan keyin kelgan javob
  const replied = msg.reply_to_message?.text || "";
  const idMatch = replied.match(/ID: ([0-9a-f]{32})/);
  if (idMatch && text && !text.startsWith("/")) {
    await notion(env, "POST", "/comments", {
      parent: { page_id: idMatch[1] }, rich_text: [{ text: { content: text } }],
    });
    return send(env, chatId, "💬 Izoh Notion'ga qo'shildi.");
  }

  const [rawCmd, ...rest] = text.split(" ");
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const args = rest.join(" ").trim();

  if (cmd === "/start") {
    await rememberChat(env, chatId);
    let out =
      "Salom! Men IELTS ZONE tasklaringizni boshqaraman.\n\n" +
      "/tasks — barcha faol tasklarim\n" +
      "/today — bugungi va muddati o'tganlar\n" +
      "/week — yaqin 7 kun\n" +
      "/new Nomi | 2026-10-20 — yangi task (sana ixtiyoriy)\n" +
      "/users — Notion foydalanuvchilari va ID'lari\n\n" +
      "Yangi task biriktirilsa, xabar beraman.";
    if (!c.allowed.length) {
      out += `\n\n⚠️ Sizning Telegram ID: <code>${msg.from.id}</code>\n` +
        "Uni Cloudflare Variables'dagi ALLOWED_TELEGRAM_IDS ga yozing.";
    }
    if (!c.user) out += `\n\n⚠️ ${NEED_USER}`;
    return send(env, chatId, out);
  }

  if (cmd === "/users") {
    const data = await notion(env, "GET", "/users?page_size=100");
    const lines = data.results.filter((u) => u.type === "person")
      .map((u) => `${esc(u.name || "?")}: <code>${u.id}</code>`);
    return send(env, chatId, "👥 Notion foydalanuvchilari:\n\n" + (lines.join("\n") || "topilmadi"));
  }

  if (["/tasks", "/today", "/week", "/new"].includes(cmd) && !c.user) {
    return send(env, chatId, NEED_USER);
  }

  if (cmd === "/tasks" || cmd === "/today" || cmd === "/week") {
    const t = today(env);
    const weekEnd = addDays(t, 7);
    let tasks = await myTasks(env);
    let title = "📋 <b>Faol tasklarim</b>";
    if (cmd === "/today") {
      tasks = tasks.filter((x) => x.due && x.due <= t);
      title = "🔥 <b>Bugun va muddati o'tgan</b>";
    } else if (cmd === "/week") {
      tasks = tasks.filter((x) => x.due && x.due <= weekEnd);
      title = "🗓 <b>Yaqin 7 kun</b>";
    }
    const v = listView(env, tasks, title);
    return send(env, chatId, v.text, v.kb);
  }

  if (cmd === "/new") {
    if (!args) return send(env, chatId, "Foydalanish: /new Task nomi | 2026-10-20");
    const [title, dueRaw] = args.split("|").map((s) => s.trim());
    if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
      return send(env, chatId, "Sana formati: YYYY-MM-DD (masalan 2026-10-20)");
    }
    const task = await createTask(env, title, dueRaw || null);
    await markSeen(env, [task.id]);
    const card = await taskCard(env, task);
    return send(env, chatId, "✅ Yaratildi\n\n" + card.text, card.kb);
  }

  return send(env, chatId, "Buyruqlar ro'yxati: /start");
}

async function onCallback(env, q) {
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const [kind, id, extra] = q.data.split(":");
  let task;
  let notice;

  if (kind === "list") {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    const v = listView(env, await myTasks(env), "📋 <b>Faol tasklarim</b>");
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: messageId, text: v.text, parse_mode: "HTML",
      reply_markup: v.kb ? { inline_keyboard: v.kb } : undefined,
    });
  }
  if (kind === "c") {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Izoh matnini shu xabarga javob (reply) qilib yozing.\nID: ${id}`,
      reply_markup: { force_reply: true },
    });
  }

  const c = cfg(env);
  if (kind === "t") {
    task = await getTask(env, id);
  } else if (kind === "s") {
    const s = await schema(env);
    const name = s.options[Number(extra)];
    task = await updateTask(env, id, { [c.status]: { [s.statusType]: { name } } });
    notice = `Status: ${name}`;
  } else if (kind === "d") {
    task = await updateTask(env, id, { [c.due]: { date: { start: addDays(today(env), Number(extra)) } } });
    notice = "Muddat yangilandi";
  } else {
    return tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: notice });
  const card = await taskCard(env, task);
  return tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "HTML",
    reply_markup: { inline_keyboard: card.kb },
  });
}

async function onUpdate(env, update) {
  const c = cfg(env);
  const from = update.message?.from || update.callback_query?.from;
  const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
  if (!from || !chatId) return;
  if (c.allowed.length && !c.allowed.includes(from.id)) {
    if (update.callback_query) {
      return tg(env, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id, text: "Ruxsat yo'q", show_alert: true,
      });
    }
    return send(env, chatId, "⛔ Bu bot shaxsiy.");
  }
  try {
    if (update.message) await onMessage(env, update.message);
    else if (update.callback_query) await onCallback(env, update.callback_query);
  } catch (e) {
    console.log(e.stack || e);
    await send(env, chatId, `⚠️ ${esc(e.message)}`);
  }
}

// ---------- xotira (KV) va fon vazifalari ----------

async function rememberChat(env, chatId) {
  if (!env.KV) return;
  const chats = JSON.parse((await env.KV.get("chats")) || "[]");
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    await env.KV.put("chats", JSON.stringify(chats));
  }
}

async function notifyChats(env) {
  const chats = env.KV ? JSON.parse((await env.KV.get("chats")) || "[]") : [];
  return [...new Set([...chats, ...cfg(env).allowed])];
}

async function markSeen(env, ids) {
  if (!env.KV) return;
  const seen = JSON.parse((await env.KV.get("seen")) || "[]");
  await env.KV.put("seen", JSON.stringify([...new Set([...seen, ...ids])]));
}

// Har 5 daqiqada: yangi biriktirilgan tasklar haqida xabar
async function checkNew(env) {
  if (!env.KV) return console.log("KV ulanmagan — yangi task xabarlari o'chiq");
  const prev = await env.KV.get("seen");
  const tasks = await myTasks(env, true);
  const seen = new Set(JSON.parse(prev || "[]"));
  const fresh = tasks.filter((t) => !seen.has(t.id));
  if (!fresh.length) return;
  await env.KV.put("seen", JSON.stringify([...seen, ...fresh.map((t) => t.id)]));
  if (prev === null) return; // birinchi ishga tushishda eski tasklarni "yangi" demaymiz
  const chats = await notifyChats(env);
  for (const t of fresh) {
    if (t.status === cfg(env).done) continue;
    const card = await taskCard(env, t);
    for (const chatId of chats) {
      await send(env, chatId, "🆕 Sizga yangi task biriktirildi!\n\n" + card.text, card.kb);
    }
  }
}

// Har kuni ertalab: bugungi va muddati o'tgan tasklar
async function digest(env) {
  const tasks = await myTasks(env);
  const t = today(env);
  const urgent = tasks.filter((x) => x.due && x.due <= t);
  const v = listView(env, urgent, `☀️ <b>Xayrli tong!</b> Faol tasklar: ${tasks.length}\n🔥 <b>Bugungi</b>`);
  for (const chatId of await notifyChats(env)) await send(env, chatId, v.text, v.kb);
}

async function webhookSecret(env) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      await onUpdate(env, await request.json());
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      const res = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: await webhookSecret(env),
        allowed_updates: ["message", "callback_query"],
      });
      await tg(env, "setMyCommands", {
        commands: [
          { command: "tasks", description: "Faol tasklarim" },
          { command: "today", description: "Bugungi va muddati o'tganlar" },
          { command: "week", description: "Yaqin 7 kun" },
          { command: "new", description: "Yangi task: /new Nomi | 2026-10-20" },
          { command: "users", description: "Notion foydalanuvchilari" },
          { command: "start", description: "Yordam" },
        ],
      });
      let check = "";
      try {
        const s = await schema(env);
        check = `✅ Notion bazasi ulandi. Statuslar: ${s.options.join(", ")}`;
      } catch (e) {
        check = `❌ Notion: ${e.message}`;
      }
      const body = res.ok
        ? `✅ Telegram bot ulandi.\n${check}\n\nEndi Telegram'da botga /start yozing.`
        : `❌ Telegram: ${res.description}\nTELEGRAM_BOT_TOKEN to'g'riligini tekshiring.\n${check}`;
      return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return new Response("Bot ishlayapti. Sozlash uchun /setup sahifasini oching.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },

  async scheduled(event, env, ctx) {
    if (!cfg(env).user) return;
    // "*/5 ..." — yangi tasklarni tekshirish, qolgan har qanday jadval — ertalabki xulosa
    if (event.cron.startsWith("*/")) ctx.waitUntil(checkNew(env));
    else ctx.waitUntil(digest(env));
  },
};

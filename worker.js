// IELTS ZONE — Notion tasklari uchun Telegram bot (Cloudflare Workers, bepul tarif)
//
// - Sizga Notion'da yangi task berilsa, Telegram'ga butun mazmuni bilan keladi
// - "▶️ Boshladim" tugmasi statusni In progress qiladi, keyin "✅ Bajarildi" chiqadi
// - "✅ Bajarildi" tugmasi: Notion'da statusni o'zgartiradi va task bergan
//   odamni izohda belgilaydi (mention) — unga Notion'da notification boradi
// - Deadline yaqinlashganda va o'tib ketganda eslatadi, har kuni ertalab xulosa
// - Faqat ALLOWED_TELEGRAM_IDS dagi foydalanuvchilar ishlata oladi

const NOTION_VERSION = "2022-06-28";

function cfg(env) {
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    db: String(env.NOTION_DATABASE_ID || "").replace(/-/g, "").trim(),
    me: String(env.NOTION_USER_ID || "").trim(),
    status: env.PROP_STATUS || "Status",
    assignee: env.PROP_ASSIGNEE || "Assignee",
    due: env.PROP_DUE || "Due date",
    reporter: String(env.PROP_REPORTER || "").trim(),
    done: env.STATUS_DONE || "Done",
    progress: env.STATUS_PROGRESS || "In progress",
    tz: env.TIMEZONE || "Asia/Tashkent",
    dueTime: env.DEFAULT_DUE_TIME || "18:00",
    remind: list(env.REMIND_HOURS || "24,3").map(Number).filter((n) => n > 0).sort((a, b) => b - a),
    allowed: list(env.ALLOWED_TELEGRAM_IDS),
  };
}

// Bepul tarifda bitta chaqiruvda 50 tagacha tashqi so'rov mumkin — hisoblab boramiz
let used = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Notion API ----------

async function notion(env, path, { method = "GET", body } = {}) {
  for (let i = 0; ; i++) {
    used++;
    const r = await fetch("https://api.notion.com/v1" + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && i < 2) {
      await sleep(1000 * (Number(r.headers.get("Retry-After")) || 1));
      continue;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Notion ${r.status}: ${data.message || r.statusText}`);
    return data;
  }
}

let schemaCache = null;
async function schema(env) {
  if (schemaCache) return schemaCache;
  const c = cfg(env);
  if (!c.db) throw new Error("NOTION_DATABASE_ID sozlanmagan");
  const db = await notion(env, `/databases/${c.db}`);
  const props = db.properties || {};
  const title = Object.keys(props).find((k) => props[k].type === "title");
  const statusType = props[c.status]?.type;
  if (!["status", "select"].includes(statusType))
    throw new Error(`Bazada "${c.status}" (Status yoki Select) ustuni topilmadi`);
  if (props[c.assignee]?.type !== "people")
    throw new Error(`Bazada "${c.assignee}" (Person) ustuni topilmadi`);
  schemaCache = { title, statusType, props, name: plain(db.title) };
  return schemaCache;
}

async function myTasks(env) {
  const c = cfg(env);
  const s = await schema(env);
  if (!c.me) throw new Error("NOTION_USER_ID sozlanmagan — botda /users buyrug'i bilan toping");
  const filter = {
    and: [
      { property: c.assignee, people: { contains: c.me } },
      { property: c.status, [s.statusType]: { does_not_equal: c.done } },
    ],
  };
  const out = [];
  let cursor = null;
  do {
    const r = await notion(env, `/databases/${c.db}/query`, {
      method: "POST",
      body: { filter, page_size: 100, ...(cursor && { start_cursor: cursor }) },
    });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  const at = (t) => dueOf(env, t)?.at.getTime() ?? Infinity;
  return out.sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));
}

const userNames = new Map();
async function userName(env, u) {
  if (!u?.id) return "";
  if (u.name) return u.name;
  if (userNames.has(u.id)) return userNames.get(u.id);
  let name = "Noma'lum";
  try {
    const r = await notion(env, `/users/${u.id}`);
    name = r.name || name;
  } catch {}
  userNames.set(u.id, name);
  return name;
}

const pageTitles = new Map();
async function pageTitle(env, id) {
  if (pageTitles.has(id)) return pageTitles.get(id);
  let t = "…";
  try {
    t = titleOf(await notion(env, `/pages/${id}`));
  } catch {}
  pageTitles.set(id, t);
  return t;
}

// Task bergan odam(lar): PROP_REPORTER ustuni bo'lsa o'sha, bo'lmasa sahifani yaratgan odam
async function giversOf(env, page) {
  const c = cfg(env);
  const p = c.reporter && page.properties[c.reporter];
  let users = [];
  if (p?.type === "people") users = p.people;
  else if (p?.type === "created_by") users = [p.created_by];
  if (!users.length && page.created_by) users = [page.created_by];
  return Promise.all(users.map(async (u) => ({ id: u.id, name: await userName(env, u) })));
}

// ---------- Matn va vaqt ----------

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (rt) => (rt || []).map((t) => t.plain_text).join("");
const short = (id) => id.replace(/-/g, "");
const notionUrl = (id) => `https://www.notion.so/${short(id)}`;

function link(url, label) {
  if (!url) return "";
  if (url.startsWith("/")) url = "https://www.notion.so" + url;
  if (!/^https?:\/\//.test(url)) return esc(label || url);
  return `<a href="${esc(url)}">${esc(label || url)}</a>`;
}

function rtHtml(rt) {
  return (rt || [])
    .map((t) => {
      let s = esc(t.plain_text);
      const a = t.annotations || {};
      if (a.code) s = `<code>${s}</code>`;
      if (a.bold) s = `<b>${s}</b>`;
      if (a.italic) s = `<i>${s}</i>`;
      if (a.underline) s = `<u>${s}</u>`;
      if (a.strikethrough) s = `<s>${s}</s>`;
      if (t.href) {
        const url = t.href.startsWith("/") ? "https://www.notion.so" + t.href : t.href;
        if (/^https?:\/\//.test(url)) s = `<a href="${esc(url)}">${s}</a>`;
      }
      return s;
    })
    .join("");
}

function titleOf(page) {
  const t = Object.values(page.properties || {}).find((p) => p.type === "title");
  return plain(t?.title) || "Nomsiz task";
}

function parts(date, tz) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return o;
}

// Mahalliy vaqtni (masalan Toshkent 18:00) UTC Date'ga aylantirish
function localToDate(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = parts(new Date(guess), tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (asUtc - guess));
}

function fmt(date, tz, withTime = true) {
  const p = parts(date, tz);
  return `${p.day}.${p.month}.${p.year}` + (withTime ? ` ${p.hour}:${p.minute}` : "");
}

function fmtIso(env, iso) {
  if (!iso) return "";
  if (iso.length === 10) {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }
  return fmt(new Date(iso), cfg(env).tz);
}

function fmtDateProp(env, d) {
  if (!d?.start) return "";
  return esc(fmtIso(env, d.start) + (d.end ? " → " + fmtIso(env, d.end) : ""));
}

// Kunlar farqi (mahalliy sana bo'yicha): 0 = bugun, 1 = ertaga, -1 = kecha
function dayDiff(date, now, tz) {
  const a = parts(date, tz), b = parts(now, tz);
  return Math.round((Date.UTC(+a.year, +a.month - 1, +a.day) - Date.UTC(+b.year, +b.month - 1, +b.day)) / 864e5);
}

function dueOf(env, page) {
  const c = cfg(env);
  const p = page.properties?.[c.due];
  const d = p?.type === "date" ? p.date : p?.type === "formula" && p.formula?.type === "date" ? p.formula.date : null;
  if (!d?.start) return null;
  const raw = d.end || d.start;
  if (raw.length === 10) {
    const [y, m, dd] = raw.split("-").map(Number);
    const [hh, mm] = c.dueTime.split(":").map(Number);
    return { at: localToDate(y, m, dd, hh || 0, mm || 0, c.tz), hasTime: false, raw };
  }
  return { at: new Date(raw), hasTime: true, raw };
}

function span(ms) {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d) return h ? `${d} kun ${h} soat` : `${d} kun`;
  if (h) return mi ? `${h} soat ${mi} daqiqa` : `${h} soat`;
  return `${mi} daqiqa`;
}

function dueText(env, due, now = new Date()) {
  const tz = cfg(env).tz;
  const when = fmt(due.at, tz, due.hasTime);
  let rel;
  if (due.hasTime) {
    const left = due.at - now;
    rel = left > 0 ? `${span(left)} qoldi` : `🔴 ${span(left)} o'tdi`;
  } else {
    const dd = dayDiff(due.at, now, tz);
    rel = dd === 0 ? "bugun" : dd === 1 ? "ertaga" : dd > 1 ? `${dd} kun qoldi` : `🔴 ${-dd} kun o'tdi`;
  }
  return `${when} (${rel})`;
}

async function propHtml(env, p) {
  if (!p) return "";
  const tz = cfg(env).tz;
  switch (p.type) {
    case "title": return rtHtml(p.title);
    case "rich_text": return rtHtml(p.rich_text);
    case "number": return p.number == null ? "" : esc(p.number);
    case "select": return esc(p.select?.name || "");
    case "status": return esc(p.status?.name || "");
    case "multi_select": return esc(p.multi_select.map((o) => o.name).join(", "));
    case "date": return fmtDateProp(env, p.date);
    case "people": return esc((await Promise.all(p.people.map((u) => userName(env, u)))).join(", "));
    case "checkbox": return p.checkbox ? "✅" : "⬜";
    case "url": return link(p.url);
    case "email": return esc(p.email || "");
    case "phone_number": return esc(p.phone_number || "");
    case "files":
      return p.files.map((f) => link(f.type === "external" ? f.external?.url : f.file?.url, f.name)).join(", ");
    case "formula": {
      const f = p.formula || {};
      if (f.type === "date") return fmtDateProp(env, f.date);
      if (f.type === "boolean") return f.boolean ? "✅" : "⬜";
      return esc(f[f.type] ?? "");
    }
    case "relation": {
      const rel = p.relation || [];
      const names = await Promise.all(rel.slice(0, 5).map((r) => pageTitle(env, r.id)));
      return esc(names.join(", ") + (rel.length > 5 ? ` va yana ${rel.length - 5} ta` : ""));
    }
    case "rollup": {
      const r = p.rollup || {};
      if (r.type === "array") return (await Promise.all(r.array.map((x) => propHtml(env, x)))).filter(Boolean).join(", ");
      if (r.type === "date") return fmtDateProp(env, r.date);
      return esc(r[r.type] ?? "");
    }
    case "created_time": return esc(fmt(new Date(p.created_time), tz));
    case "created_by": return esc(await userName(env, p.created_by));
    case "unique_id": {
      const u = p.unique_id || {};
      return u.number == null ? "" : esc((u.prefix ? u.prefix + "-" : "") + u.number);
    }
    default: return "";
  }
}

// Sahifa ichidagi kontent (matn, ro'yxatlar, checklistlar, fayllar...) → HTML qatorlar
async function blocksHtml(env, id, depth = 0, out = []) {
  let cursor = null, num = 0;
  do {
    if (used > 40) {
      out.push("<i>… davomini Notion'da ko'ring</i>");
      return out;
    }
    const r = await notion(env, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of r.results) {
      const d = b[b.type] || {};
      const t = rtHtml(d.rich_text);
      const ind = "    ".repeat(depth);
      num = b.type === "numbered_list_item" ? num + 1 : 0;
      let line = null;
      switch (b.type) {
        case "paragraph": line = t; break;
        case "heading_1": case "heading_2": case "heading_3": line = `<b>${t}</b>`; break;
        case "bulleted_list_item": line = `• ${t}`; break;
        case "numbered_list_item": line = `${num}. ${t}`; break;
        case "to_do": line = `${d.checked ? "☑️" : "⬜"} ${t}`; break;
        case "toggle": line = `▸ ${t}`; break;
        case "quote": line = `┃ <i>${t}</i>`; break;
        case "callout": line = `${d.icon?.emoji || "💡"} ${t}`; break;
        case "code": line = `<pre>${esc(plain(d.rich_text))}</pre>`; break;
        case "equation": line = `<code>${esc(d.expression)}</code>`; break;
        case "divider": line = "──────────"; break;
        case "image": case "file": case "pdf": case "video": case "audio": {
          const url = d.type === "external" ? d.external?.url : d.file?.url;
          const label = { image: "Rasm", video: "Video", audio: "Audio", pdf: "PDF" }[b.type] || d.name || "Fayl";
          const cap = rtHtml(d.caption);
          if (url) line = `📎 ${link(url, label)}${cap ? " — " + cap : ""}`;
          break;
        }
        case "bookmark": case "embed": case "link_preview":
          if (d.url) line = `🔗 ${link(d.url)}`;
          break;
        case "child_page": line = `📄 ${esc(d.title)}`; break;
        case "child_database": line = `🗂 ${esc(d.title)}`; break;
        case "table_row": line = (d.cells || []).map(rtHtml).join(" | "); break;
      }
      if (line !== null) out.push(ind + line);
      if (b.has_children && depth < 3 && !["child_page", "child_database"].includes(b.type)) {
        const flat = ["table", "column_list", "column", "synced_block"].includes(b.type);
        const child = b.type === "synced_block" && d.synced_from?.block_id ? d.synced_from.block_id : b.id;
        await blocksHtml(env, child, flat ? depth : depth + 1, out);
        if (used > 40) return out;
      }
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

// Task kartochkasi: sarlavha, deadline, status, kim bergan, barcha ustunlar va sahifa matni
async function cardChunks(env, page, header = "") {
  const c = cfg(env);
  const s = await schema(env);
  const props = page.properties || {};
  const out = [];
  if (header) out.push(header, "");
  out.push(`📌 <b>${esc(titleOf(page))}</b>`, "");
  const due = dueOf(env, page);
  out.push(`📅 <b>Deadline:</b> ${due ? esc(dueText(env, due)) : "belgilanmagan"}`);
  const st = await propHtml(env, props[c.status]);
  if (st) out.push(`🔄 <b>Status:</b> ${st}`);
  const givers = await giversOf(env, page);
  if (givers.length) out.push(`👤 <b>Topshiriq bergan:</b> ${esc(givers.map((g) => g.name).join(", "))}`);
  const skip = new Set([s.title, c.status, c.due, c.assignee, c.reporter]);
  for (const [name, p] of Object.entries(props)) {
    if (skip.has(name)) continue;
    const v = await propHtml(env, p);
    if (v) out.push(`▫️ <b>${esc(name)}:</b> ${v}`);
  }
  const body = await blocksHtml(env, page.id);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (body.some((l) => l.trim())) out.push("", "━━━━━━━━━━━━━━", ...body);
  return out;
}

// ---------- Telegram ----------

async function tg(env, method, payload) {
  used++;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) console.log(`Telegram ${method}: ${d.description}`);
  return d;
}

const stripTags = (h) =>
  h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function send(env, chat_id, text, extra = {}) {
  const d = await tg(env, "sendMessage", {
    chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra,
  });
  if (!d.ok && /parse entities/i.test(d.description || ""))
    return tg(env, "sendMessage", { chat_id, text: stripTags(text), disable_web_page_preview: true, ...extra });
  return d;
}

// Telegram xabari 4096 belgidan oshmasligi kerak — qatorlar bo'yicha bo'lib yuboramiz
async function sendChunks(env, chat_id, lines, reply_markup) {
  const MAX = 3900;
  const msgs = [];
  let cur = "";
  for (let line of lines) {
    if (line.length > MAX) line = esc(stripTags(line).slice(0, MAX - 100)) + "…";
    if (cur && cur.length + 1 + line.length > MAX) {
      msgs.push(cur);
      cur = line;
    } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) msgs.push(cur);
  for (let i = 0; i < msgs.length; i++)
    await send(env, chat_id, msgs[i], i === msgs.length - 1 && reply_markup ? { reply_markup } : {});
}

const statusOf = (env, page) => {
  const p = page.properties?.[cfg(env).status];
  return p?.status?.name || p?.select?.name || "";
};
const inProgress = (env, page) => statusOf(env, page).trim().toLowerCase() === cfg(env).progress.trim().toLowerCase();

// Task boshlanmagan bo'lsa "▶️ Boshladim", In progress bo'lsa "✅ Bajarildi" tugmasi
const actionBtn = (id, started) =>
  started
    ? { text: "✅ Bajarildi", callback_data: `d:${short(id)}` }
    : { text: "▶️ Boshladim", callback_data: `p:${short(id)}` };
const kbFor = (id, started) => ({
  inline_keyboard: [[actionBtn(id, started), { text: "🔗 Notion'da ochish", url: notionUrl(id) }]],
});
const taskKb = (env, page) => kbFor(page.id, inProgress(env, page));

async function hookSecret(env) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

// ---------- Buyruqlar ----------

const HELP = `🤖 <b>IELTS ZONE — Tasks bot</b>

Sizga Notion'da task berilsa, shu yerga to'liq mazmuni bilan keladi.
Ishni boshlaganda <b>▶️ Boshladim</b> ni bosing — Notion'da status <i>In progress</i> bo'ladi.
Ish tugagach <b>✅ Bajarildi</b> ni bosing — status <i>Done</i> bo'ladi va task bergan odamga Notion'da xabar boradi.

/tasks — barcha faol tasklarim
/today — muddati o'tgan, bugungi va ertangi tasklar
/users — Notion foydalanuvchilari va ID'lari
/help — yordam`;

async function cmdTasks(env, chat) {
  const tasks = await myTasks(env);
  if (!tasks.length) return send(env, chat, "🎉 Hozircha faol task yo'q.");
  const lines = [`📋 <b>Faol tasklar: ${tasks.length} ta</b>`, ""];
  tasks.forEach((t, i) => {
    const due = dueOf(env, t);
    lines.push(`${i + 1}. ${inProgress(env, t) ? "🔵" : "⚪"} ${esc(titleOf(t))}${due ? `\n     📅 ${esc(dueText(env, due))}` : ""}`);
  });
  lines.push("", "🔵 — jarayonda, ⚪ — boshlanmagan", "Batafsil ko'rish uchun tugmani bosing 👇");
  const kb = { inline_keyboard: tasks.slice(0, 40).map((t, i) => [{ text: `${i + 1}. ${titleOf(t).slice(0, 50)}`, callback_data: `v:${short(t.id)}` }]) };
  return sendChunks(env, chat, lines, kb);
}

// Ertalabki xulosa va /today: muddati o'tgan, bugungi va ertangi tasklar
async function digest(env, chats, manual = false) {
  const tz = cfg(env).tz;
  const now = new Date();
  const tasks = await myTasks(env);
  const groups = { over: [], today: [], tomorrow: [] };
  for (const t of tasks) {
    const due = dueOf(env, t);
    if (!due) continue;
    const dd = dayDiff(due.at, now, tz);
    if (due.at < now) groups.over.push(t);
    else if (dd === 0) groups.today.push(t);
    else if (dd === 1) groups.tomorrow.push(t);
  }
  const all = [...groups.over, ...groups.today, ...groups.tomorrow];
  if (!all.length && !manual) return;
  const lines = [`☀️ <b>Tasklar xulosasi — ${fmt(now, tz, false)}</b>`];
  const add = (title, list) => {
    if (!list.length) return;
    lines.push("", `<b>${title}</b>`);
    for (const t of list) lines.push(`• ${esc(titleOf(t))} — ${esc(fmt(dueOf(env, t).at, tz, dueOf(env, t).hasTime))}`);
  };
  add("🔴 Muddati o'tgan:", groups.over);
  add("🟡 Bugun:", groups.today);
  add("🟢 Ertaga:", groups.tomorrow);
  if (!all.length) lines.push("", "Bugun va ertaga deadline yo'q 👌");
  lines.push("", `Jami faol tasklar: ${tasks.length} ta — /tasks`);
  const kb = all.length
    ? { inline_keyboard: all.slice(0, 30).map((t) => [{ text: titleOf(t).slice(0, 55), callback_data: `v:${short(t.id)}` }]) }
    : undefined;
  for (const chat of chats) await sendChunks(env, chat, lines, kb);
}

async function cmdUsers(env, chat) {
  const lines = ["👥 <b>Notion foydalanuvchilari</b>", ""];
  let cursor = null;
  do {
    const r = await notion(env, `/users?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const u of r.results) if (u.type === "person") lines.push(`${esc(u.name || "—")}\n<code>${u.id}</code>`);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  lines.push("", "O'zingizning ID'ingizni Cloudflare'da <b>NOTION_USER_ID</b> ga yozing.");
  return sendChunks(env, chat, lines);
}

async function onMessage(env, m) {
  const c = cfg(env);
  const uid = String(m.from?.id);
  const chat = m.chat.id;
  if (!c.allowed.includes(uid)) {
    return send(env, chat, c.allowed.length
      ? `⛔ Bu bot faqat ruxsat berilgan foydalanuvchilar uchun.\nSizning ID: <code>${uid}</code>`
      : `Sizning Telegram ID: <code>${uid}</code>\nUni Cloudflare'da <b>ALLOWED_TELEGRAM_IDS</b> ga yozing.`);
  }
  const cmd = (m.text || "").trim().split(/[\s@]/)[0].toLowerCase();
  try {
    if (cmd === "/tasks") return await cmdTasks(env, chat);
    if (cmd === "/today") return await digest(env, [chat], true);
    if (cmd === "/users") return await cmdUsers(env, chat);
    return await send(env, chat, HELP);
  } catch (e) {
    return send(env, chat, `⚠️ Xatolik: ${esc(e.message)}`);
  }
}

async function setStatus(env, id, name) {
  const c = cfg(env);
  const s = await schema(env);
  return notion(env, `/pages/${id}`, {
    method: "PATCH",
    body: { properties: { [c.status]: { [s.statusType]: { name } } } },
  });
}

// "Bajarildi": statusni o'zgartirish + task bergan odamni izohda belgilash (Notion notification)
async function markDone(env, id) {
  const c = cfg(env);
  const page = await setStatus(env, id, c.done);
  const targets = (await giversOf(env, page)).filter((g) => short(g.id) !== short(c.me));
  const rich_text = [];
  for (const g of targets)
    rich_text.push({ type: "mention", mention: { type: "user", user: { id: g.id } } }, { type: "text", text: { content: " " } });
  rich_text.push({ type: "text", text: { content: "✅ Task bajarildi (Telegram bot orqali belgilandi)." } });
  let commentError = null;
  try {
    await notion(env, "/comments", { method: "POST", body: { parent: { page_id: id }, rich_text } });
  } catch (e) {
    commentError = e.message;
  }
  return { page, targets, commentError };
}

async function onCallback(env, q) {
  const c = cfg(env);
  const chat = q.message?.chat.id;
  const mid = q.message?.message_id;
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...(text && { text }) });
  if (!c.allowed.includes(String(q.from.id))) return answer("⛔ Ruxsat yo'q");
  const [act, id] = String(q.data || "").split(":");
  const setKb = (reply_markup) => tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup });

  try {
    if (act === "v") {
      await answer();
      const page = await notion(env, `/pages/${id}`);
      return await sendChunks(env, chat, await cardChunks(env, page), taskKb(env, page));
    }
    if (act === "d") {
      await answer("Rostdan ham bajarildimi?");
      return await setKb({
        inline_keyboard: [[
          { text: "✅ Ha, bajarildi", callback_data: `y:${id}` },
          { text: "↩️ Yo'q", callback_data: `n:${id}` },
        ]],
      });
    }
    if (act === "n") {
      await answer("Bekor qilindi");
      return await setKb(kbFor(id, true));
    }
    if (act === "p") {
      await answer("⏳ Notion'ga yozilmoqda...");
      const page = await setStatus(env, id, c.progress);
      await setKb(kbFor(id, true));
      return await send(env, chat, `▶️ <b>${esc(titleOf(page))}</b> — ish boshlandi (${esc(c.progress)}).\nTugatgach <b>✅ Bajarildi</b> tugmasini bosing.`);
    }
    if (act === "y") {
      await answer("⏳ Notion'ga yozilmoqda...");
      const { page, targets, commentError } = await markDone(env, id);
      await setKb({ inline_keyboard: [[{ text: "✅ Bajarilgan · 🔗 Notion", url: notionUrl(id) }]] });
      let text = `✅ <b>${esc(titleOf(page))}</b> — bajarildi deb belgilandi.`;
      if (commentError) text += `\n\n⚠️ Statusi o'zgardi, lekin Notion'ga izoh yozilmadi: ${esc(commentError)}\n(Integratsiyaga "Insert comments" ruxsatini bering.)`;
      else if (targets.length) text += `\n🔔 ${esc(targets.map((t) => t.name).join(", "))} ga Notion'da xabar yuborildi.`;
      return await send(env, chat, text);
    }
    return await answer();
  } catch (e) {
    if (act === "y") await setKb(kbFor(id, true));
    return send(env, chat, `⚠️ Xatolik: ${esc(e.message)}`);
  }
}

// ---------- Fon tekshiruvi: yangi tasklar va deadline eslatmalari ----------

async function checkTasks(env) {
  const c = cfg(env);
  if (!env.KV) return console.log("KV ulanmagan — yangi tasklar va eslatmalar ishlamaydi");
  const tasks = await myTasks(env);
  const now = new Date();
  const raw = await env.KV.get("state");
  const st = raw ? JSON.parse(raw) : { init: false, seen: [], rem: {} };
  const firstRun = !st.init;
  const seen = new Set(st.seen);
  const rem = st.rem || {};

  // Deadline'gacha qaysi eslatma bosqichlari kelganini hisoblaydi
  const stages = (t, due) => {
    const left = due.at - now;
    const base = `${short(t.id)}|${due.raw}|`;
    if (left <= 0) return { all: [base + "over", ...c.remind.map((h) => base + h)], last: base + "over" };
    const hit = c.remind.filter((h) => left <= h * 3600e3);
    return { all: hit.map((h) => base + h), last: hit.length ? base + hit[hit.length - 1] : null };
  };

  for (const t of tasks) {
    const id = short(t.id);
    const due = dueOf(env, t);
    if (!seen.has(id)) {
      if (!firstRun) {
        if (used > 25) continue; // qolganlari keyingi tekshiruvda (5 daqiqadan keyin) yuboriladi
        const lines = await cardChunks(env, t, "🆕 <b>Sizga yangi task berildi!</b>");
        for (const chat of c.allowed) await sendChunks(env, chat, lines, taskKb(env, t));
      }
      seen.add(id);
      if (due) for (const k of stages(t, due).all) rem[k] = 1;
      continue;
    }
    if (!due) continue;
    const { all, last } = stages(t, due);
    if (!last || rem[last] || used > 40) continue;
    const over = last.endsWith("|over");
    const text = `${over ? "🔴 <b>Deadline o'tib ketdi!</b>" : "⏰ <b>Deadline yaqinlashmoqda!</b>"}\n\n📌 ${esc(titleOf(t))}\n📅 ${esc(dueText(env, due, now))}`;
    const kb = {
      inline_keyboard: [[
        { text: "📄 Batafsil", callback_data: `v:${id}` },
        actionBtn(id, inProgress(env, t)),
      ]],
    };
    for (const chat of c.allowed) await send(env, chat, text, { reply_markup: kb });
    for (const k of all) rem[k] = 1;
  }

  if (firstRun) {
    for (const chat of c.allowed)
      await send(env, chat, `🤖 Bot ulandi! Hozir sizda <b>${tasks.length} ta</b> faol task bor — /tasks\nEndi yangi tasklar va deadline eslatmalari shu yerga keladi.`);
  }

  // Faqat hozir faol tasklarni eslab qolamiz
  const active = new Set(tasks.map((t) => short(t.id)));
  const next = {
    init: true,
    seen: [...seen].filter((id) => active.has(id)),
    rem: Object.fromEntries(Object.keys(rem).filter((k) => active.has(k.split("|")[0])).map((k) => [k, 1])),
  };
  const out = JSON.stringify(next);
  if (out !== raw) await env.KV.put("state", out);
}

// ---------- Kirish nuqtalari ----------

async function setup(env, origin) {
  const c = cfg(env);
  const lines = [];
  const need = ["TELEGRAM_BOT_TOKEN", "NOTION_TOKEN", "NOTION_DATABASE_ID"];
  for (const k of need) lines.push(env[k] ? `✅ ${k}` : `❌ ${k} — Settings → Variables and Secrets'ga qo'shing`);
  lines.push(c.allowed.length ? `✅ ALLOWED_TELEGRAM_IDS: ${c.allowed.join(", ")}` : "⚠️ ALLOWED_TELEGRAM_IDS bo'sh — botga /start yozing, u ID'ingizni aytadi");
  lines.push(c.me ? "✅ NOTION_USER_ID" : "⚠️ NOTION_USER_ID bo'sh — botga /users yozib, o'zingizni toping");
  lines.push(env.KV ? "✅ KV ulangan" : "❌ KV ulanmagan — Settings → Bindings → KV namespace (Variable name: KV)");
  if (env.NOTION_TOKEN && c.db) {
    try {
      const s = await schema(env);
      lines.push(`✅ Notion bazasi: "${s.name}" (status turi: ${s.statusType})`);
      if (!s.props[c.due]) lines.push(`⚠️ "${c.due}" ustuni topilmadi — PROP_DUE ni to'g'rilang. Ustunlar: ${Object.keys(s.props).join(", ")}`);
      if (c.reporter && !s.props[c.reporter]) lines.push(`⚠️ "${c.reporter}" ustuni topilmadi — PROP_REPORTER ni to'g'rilang`);
    } catch (e) {
      lines.push(`❌ Notion: ${e.message}`);
    }
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    const r = await tg(env, "setWebhook", {
      url: `${origin}/telegram`,
      secret_token: await hookSecret(env),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    lines.push(r.ok ? "✅ Telegram webhook o'rnatildi" : `❌ Telegram: ${r.description}`);
    await tg(env, "setMyCommands", {
      commands: [
        { command: "tasks", description: "Barcha faol tasklarim" },
        { command: "today", description: "Muddati o'tgan, bugungi va ertangi tasklar" },
        { command: "users", description: "Notion foydalanuvchilari va ID'lari" },
        { command: "help", description: "Yordam" },
      ],
    });
  }
  return lines.join("\n");
}

export default {
  async fetch(request, env) {
    used = 0;
    const url = new URL(request.url);
    if (url.pathname === "/setup") {
      return new Response(await setup(env, url.origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await hookSecret(env)))
        return new Response("forbidden", { status: 403 });
      const upd = await request.json();
      try {
        if (upd.message) await onMessage(env, upd.message);
        else if (upd.callback_query) await onCallback(env, upd.callback_query);
      } catch (e) {
        console.log("update error:", e.stack || e.message);
      }
      return new Response("ok");
    }
    return new Response("IELTS ZONE Tasks bot ishlayapti ✅", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    used = 0;
    const job = event.cron.startsWith("*/") ? checkTasks(env) : digest(env, cfg(env).allowed);
    ctx.waitUntil(job.catch((e) => console.log("cron error:", e.stack || e.message)));
  },
};

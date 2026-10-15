// Nutrition Bot Lite: Telegram -> Gemini -> Google Sheets (one row per food item, "Items" tab)
// Secrets live in Config.gs (private, never committed). See Config.example.gs.
// First-time setup: follow SETUP.md, then run setup() from the editor.

// ===================== SETTINGS (not secret) =====================
const GEMINI_MODEL      = 'gemini-3.8-flash';
const USE_GOOGLE_SEARCH = true;   // look up official nutrition info for named restaurants/brands (needs paid Gemini tier)
const USE_USDA          = true;   // look up items in USDA FoodData Central when no official numbers were found
const USE_OPEN_FOOD_FACTS = true; // backup lookup for packaged products not found in USDA
const DRAFT_TTL_HOURS   = 2;      // unsaved drafts auto-save after this long
const ALBUM_WAIT_MS     = 4000;   // how long to wait for every photo in an album to arrive
const EDIT_WINDOW_MIN   = 30;     // after tapping Edit, your next message counts as a correction for this long
const MEAL_WINDOW_MIN   = 60;     // food eaten within this long of your last meal entry keeps its meal label (unless you say otherwise)
const MEAL_TIMES = [              // local 24h times, start and end included; anything else is a Snack unless you name the meal
  { meal: 'Breakfast', from: '05:00', to: '10:30' },
  { meal: 'Lunch',     from: '11:00', to: '14:00' },
  { meal: 'Dinner',    from: '17:00', to: '20:30' }
];
const ITEMS_TAB         = 'Items'; // tab the bot saves to, one row per food item (created automatically)
// =================================================================

const PROPS = PropertiesService.getScriptProperties(); // SEEN_IDS, DRAFT_<id>, ALBUM_<id>, AWAITING_EDIT_<chat>, LAST_MEAL_<chat>
let LOCK_HELD = false; // per-execution flag so nested lock calls don't deadlock

// Config values are read inside functions (not at top level) so file order in the project doesn't matter
function tgBase_() { return `https://api.telegram.org/bot${BOT_TOKEN}`; }

/** Every time uses the Sheet's time zone (File → Settings), so meal labels and the times shown in the Sheet always agree. */
let TZ_ = null;
function tz_() { return TZ_ || (TZ_ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()); }

// =============== MODE 1: WEBHOOK VIA CLOUDFLARE WORKER (current) ===============

function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.secret !== WEBHOOK_SECRET) return ok_();
    if (!e.postData || !e.postData.contents) return ok_();
    const update = JSON.parse(e.postData.contents);
    if (!update.update_id) return ok_();
    const isNew = withLock_(() => markSeen_(update.update_id));
    if (isNew) processUpdate_(update);
  } catch (err) {
    Logger.log('doPost error: ' + (err.stack || err));
  }
  return ok_();
}

// =============== MODE 2: POLLING (fallback) ===============

function pollTelegram() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  LOCK_HELD = true;
  try {
    const started = Date.now();
    const updates = tgGetUpdates_({ timeout: 0, allowed_updates: ['message', 'callback_query'] });
    for (const update of updates) {
      if (Date.now() - started > 4 * 60 * 1000) break;
      tgGetUpdates_({ offset: update.update_id + 1, limit: 1, timeout: 0 }); // confirm before processing
      if (!markSeen_(update.update_id)) continue;

      const msg = update.message;
      if (msg && msg.photo && msg.media_group_id) {
        // Handle the whole album from this batch in one go
        const group = updates.filter(u => u.message && u.message.media_group_id === msg.media_group_id);
        group.forEach(u => markSeen_(u.update_id));
        processAlbumBatch_(group.map(u => u.message));
        continue;
      }
      processUpdate_(update);
    }
  } catch (err) {
    Logger.log('pollTelegram error: ' + (err.stack || err));
  } finally {
    LOCK_HELD = false;
    lock.releaseLock();
  }
}

function tgGetUpdates_(params) {
  const res = UrlFetchApp.fetch(`${tgBase_()}/getUpdates`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(params),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error('getUpdates failed: ' + res.getContentText().slice(0, 300));
  return body.result;
}

// =============== ROUTING ===============

function processUpdate_(update) {
  let chatId = null;
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
      handleButton_(cq, chatId);
      return;
    }

    const msg = update.message;
    if (!msg || !msg.chat) return;
    chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';

    if (text.toLowerCase() === '/id') {
      sendTelegramMessage(chatId, 'Your chat ID: ' + chatId);
      return;
    }
    if (!ALLOWED_CHAT_ID) {
      sendTelegramMessage(chatId, 'Setup isn\'t finished: put your chat ID (' + chatId + ') in ALLOWED_CHAT_ID in Config.gs, then deploy a new version.');
      return;
    }
    if (!isAllowed_(chatId)) return;

    // Barcode from the in-Telegram scanner
    if (msg.web_app_data) {
      let data = {};
      try { data = JSON.parse(msg.web_app_data.data); } catch (_) {}
      if (data.type === 'barcode') handleBarcode_(msg, data.code, data.note || '');
      return;
    }

    const cmd = text.toLowerCase().split(/[\s@]/)[0];
    if (cmd === '/scan' || cmd === '/start') {
      sendTelegramMessage(chatId,
        '📷 Tap "Scan barcode" at the bottom of the chat to open the scanner. You can also type a barcode number, e.g. 012345678905 or "012345678905 2 servings".',
        scanKeyboard_());
      return;
    }
    if (cmd === '/hidescan') {
      sendTelegramMessage(chatId, 'Scanner button hidden. Send /scan to bring it back.', { remove_keyboard: true });
      return;
    }
    if (text.startsWith('/')) return; // ignore other commands

    // A typed barcode number, optionally followed by a portion note
    const typed = text ? parseTypedBarcode_(text) : null;
    if (typed) {
      if (typed.code) {
        handleBarcode_(msg, typed.code, typed.note);
      } else {
        sendTelegramMessage(chatId, `⚠️ ${typed.invalid} doesn't look like a valid barcode (a digit may be off). Double-check the number, or use /scan.`);
      }
      return;
    }

    if (!msg.photo && !text) {
      sendTelegramMessage(chatId, '⚠️ Please send a food photo or text description.');
      return;
    }

    // Several photos sent together (an album) = one meal
    if (msg.photo && msg.media_group_id) {
      handleAlbumPhoto_(msg);
      return;
    }

    // A reply to a draft, or a message right after tapping Edit, corrects that draft
    const draftId = findDraftToCorrect_(chatId, msg);
    if (draftId) {
      if (msg.photo) {
        reviseDraft_(draftId, msg.caption || 'Added another photo of this meal.', [pickPhoto_(msg.photo).file_id]);
      } else {
        reviseDraft_(draftId, text);
      }
      return;
    }

    createDraft_({
      chatId: chatId,
      date: msg.date,
      description: msg.photo ? (msg.caption || '') : text,
      fileIds: msg.photo ? [pickPhoto_(msg.photo).file_id] : []
    });

  } catch (err) {
    reportError_(chatId, err);
  }
}

/** Only ALLOWED_CHAT_ID can use the bot; if it's blank, nobody can (so strangers can't spend your Gemini credits). */
function isAllowed_(chatId) {
  return !!ALLOWED_CHAT_ID && String(chatId) === String(ALLOWED_CHAT_ID);
}

function reportError_(chatId, err) {
  Logger.log(err.stack || err);
  if (!chatId) return;
  try {
    sendTelegramMessage(chatId, '⚠️ Error: ' + String(err.message || err).slice(0, 500) +
      '\nResend if you want to retry.');
  } catch (_) {}
}

// =============== ALBUMS (several photos = one meal) ===============

/** Webhook mode: each album photo arrives as its own message. The first one waits, then handles them all. */
function handleAlbumPhoto_(msg) {
  const mgid = msg.media_group_id;
  const fileId = pickPhoto_(msg.photo).file_id;
  let role = null;

  withLock_(() => {
    let rec = getAlbum_(mgid);
    if (!rec) {
      rec = newAlbum_(mgid, msg.chat.id, msg.date);
      role = 'leader';
    } else {
      role = rec.done ? 'late' : 'member';
    }
    if (role !== 'late') {
      rec.fileIds.push(fileId);
      if (msg.caption) rec.captions.push(msg.caption);
      if (msg.reply_to_message) rec.replyTo = msg.reply_to_message.message_id;
      rec.lastAt = Date.now();
      saveAlbum_(rec);
    }
  });

  if (role === 'member') return;
  if (role === 'late') { addLatePhoto_(msg, fileId); return; }

  // Leader: wait until no new photo has arrived for 2 seconds (max ~12s)
  const start = Date.now();
  Utilities.sleep(ALBUM_WAIT_MS);
  while (Date.now() - start < 12000) {
    const cur = getAlbum_(mgid);
    if (!cur || Date.now() - cur.lastAt >= 2000) break;
    Utilities.sleep(1000);
  }

  let rec = null;
  withLock_(() => {
    rec = getAlbum_(mgid);
    if (rec) { rec.done = true; saveAlbum_(rec); }
  });
  if (rec) finishAlbum_(rec);
}

/** Polling mode: the whole album usually arrives in one batch. */
function processAlbumBatch_(msgs) {
  const first = msgs[0];
  const chatId = first.chat.id;
  if (!isAllowed_(chatId)) return;
  try {
    const mgid = first.media_group_id;
    const fileIds = msgs.map(m => pickPhoto_(m.photo).file_id);
    const captions = msgs.map(m => m.caption).filter(Boolean);

    // Rest of an album whose first part came in an earlier batch
    const existing = getAlbum_(mgid);
    if (existing && existing.draftId && getDraft_(existing.draftId)) {
      reviseDraft_(existing.draftId, captions.join('\n') || `Added ${fileIds.length} more photo(s) of this meal.`, fileIds);
      return;
    }

    const rec = newAlbum_(mgid, chatId, first.date);
    rec.fileIds = fileIds;
    rec.captions = captions;
    const replyMsg = msgs.find(m => m.reply_to_message);
    rec.replyTo = replyMsg ? replyMsg.reply_to_message.message_id : null;
    rec.done = true;
    finishAlbum_(rec);
  } catch (err) {
    reportError_(chatId, err);
  }
}

/** Turns a collected album into a new draft, or adds it to the draft being corrected. */
function finishAlbum_(rec) {
  const caption = rec.captions.join('\n');
  let draftId = 'none';
  try {
    const fakeMsg = rec.replyTo ? { reply_to_message: { message_id: rec.replyTo } } : {};
    const target = findDraftToCorrect_(rec.chatId, fakeMsg);
    if (target) {
      reviseDraft_(target, caption || `Added ${rec.fileIds.length} more photo(s) of this meal.`, rec.fileIds);
      draftId = target;
    } else {
      draftId = createDraft_({ chatId: rec.chatId, date: rec.date, description: caption, fileIds: rec.fileIds });
    }
  } finally {
    // Record the result so photos that arrive late join this draft (or start their own if it failed)
    withLock_(() => {
      const cur = getAlbum_(rec.mgid) || rec;
      cur.done = true;
      cur.draftId = draftId;
      saveAlbum_(cur);
    });
  }
}

/** A photo that arrived after its album was already being processed. */
function addLatePhoto_(msg, fileId) {
  const mgid = msg.media_group_id;
  let rec = getAlbum_(mgid);
  const start = Date.now();
  while (rec && !rec.draftId && Date.now() - start < 60000) { // wait for the draft to exist
    Utilities.sleep(2000);
    rec = getAlbum_(mgid);
  }
  if (rec && rec.draftId && getDraft_(rec.draftId)) {
    reviseDraft_(rec.draftId, msg.caption || 'Added one more photo of this meal.', [fileId]);
  } else {
    createDraft_({ chatId: msg.chat.id, date: msg.date, description: msg.caption || '', fileIds: [fileId] });
  }
}

function newAlbum_(mgid, chatId, date) {
  return { mgid: mgid, chatId: chatId, date: date, fileIds: [], captions: [], replyTo: null,
           lastAt: Date.now(), created: Date.now(), done: false, draftId: null };
}
function getAlbum_(mgid) { const s = PROPS.getProperty('ALBUM_' + mgid); return s ? JSON.parse(s) : null; }
function saveAlbum_(rec) { PROPS.setProperty('ALBUM_' + rec.mgid, JSON.stringify(rec)); }

// =============== DRAFTS ===============

/** Creates a draft, analyzes it, posts it with buttons. Returns the draft ID. */
function createDraft_(p) {
  sendChatAction_(p.chatId, 'typing');
  const d = {
    id: Utilities.getUuid().replace(/-/g, '').slice(0, 10),
    chatId: p.chatId,
    timestamp: Utilities.formatDate(new Date(p.date * 1000), tz_(), 'yyyy-MM-dd HH:mm:ss'),
    description: p.description || '',
    photoFileIds: (p.fileIds || []).slice(0, 10),
    noSearch: !!p.noSearch, // barcode entries already have exact data
    corrections: [],
    result: null,
    msgId: null,
    msgIds: [],
    updatedAt: Date.now()
  };
  d.result = analyze_(d);
  finalizeResult_(d, null);
  postDraft_(d);
  return d.id;
}

/** Applies a text correction and/or extra photos, re-analyzes, re-posts. */
function reviseDraft_(id, correction, newFileIds) {
  const d = getDraft_(id);
  if (!d) return;
  removeButtons_(d.chatId, d.msgId); // prevent saving the stale version mid-revision
  sendChatAction_(d.chatId, 'typing');

  const prevIds = photoIds_(d).slice();
  d.photoFileIds = prevIds.concat(newFileIds || []).slice(0, 10);
  d.corrections.push(correction);
  const prev = d.result;
  try {
    d.result = analyze_(d);
    finalizeResult_(d, prev);
  } catch (err) {
    d.result = prev;
    d.corrections.pop();
    d.photoFileIds = prevIds;
    postDraft_(d); // re-post the unchanged draft so its buttons come back
    throw err;
  }
  if (!getDraft_(id)) return; // saved or discarded meanwhile
  postDraft_(d);
}

function postDraft_(d) {
  const n = photoIds_(d).length;
  const header = '📝 Draft (not saved yet)' + (n > 1 ? ` · ${n} photos` : '');
  const text = header + '\n\n' + summary_(d.result, d) + '\n\nTap Save, or Edit to correct.';
  d.msgId = sendTelegramMessage(d.chatId, text, draftButtons_(d.id));
  if (d.msgId) d.msgIds.push(d.msgId);
  d.updatedAt = Date.now();
  saveDraftObj_(d);
}

function handleButton_(cq, chatId) {
  answerCallback_(cq.id); // stop the button's loading spinner right away
  if (!chatId || !isAllowed_(chatId)) return;

  const parts = String(cq.data || '').split(':');
  const action = parts[0];
  const id = parts[1];

  if (action === 'edit') {
    if (!getDraft_(id)) {
      sendTelegramMessage(chatId, 'That draft was already saved or discarded.');
      return;
    }
    PROPS.setProperty('AWAITING_EDIT_' + chatId, id + '|' + Date.now());
    sendTelegramMessage(chatId,
      '✏️ What should I change? Reply in plain words, e.g. "it was 2 bananas", "this was at Chipotle", "I ate this at noon" or "this was lunch". Or send another photo of this meal.');
    return;
  }
  if (action !== 'save' && action !== 'discard') return;

  let d = null;
  withLock_(() => {
    d = getDraft_(id);
    if (!d) return;                                    // double tap / already handled
    if (action === 'save') saveEntry_(d);
    deleteDraft_(id);
  });
  if (!d) return;

  const awaiting = PROPS.getProperty('AWAITING_EDIT_' + chatId) || '';
  if (awaiting.split('|')[0] === id) PROPS.deleteProperty('AWAITING_EDIT_' + chatId);
  editMessage_(chatId, d.msgId,
    (action === 'save' ? '✅ Saved to Sheet' : '🗑 Discarded') + '\n\n' + summary_(d.result, action === 'save' ? d : null));
}

/** A message corrects a draft if it replies to a draft message, or comes soon after an Edit tap. */
function findDraftToCorrect_(chatId, msg) {
  if (msg.reply_to_message) {
    const replyId = msg.reply_to_message.message_id;
    const match = allDrafts_().find(d => d.chatId === chatId && d.msgIds.indexOf(replyId) !== -1);
    if (match) return match.id;
  }
  const key = 'AWAITING_EDIT_' + chatId;
  const val = PROPS.getProperty(key);
  if (val) {
    PROPS.deleteProperty(key);
    const [id, at] = val.split('|');
    const fresh = !at || Date.now() - Number(at) < EDIT_WINDOW_MIN * 60 * 1000;
    if (fresh && getDraft_(id)) return id;
  }
  return null;
}

/** Hourly trigger: saves drafts untouched for DRAFT_TTL_HOURS, and clears old album records. */
function autoSaveDrafts() {
  const cutoff = Date.now() - DRAFT_TTL_HOURS * 3600 * 1000;
  for (const d of allDrafts_()) {
    if (d.updatedAt > cutoff) continue;
    try {
      let saved = false;
      withLock_(() => {
        const cur = getDraft_(d.id);
        if (!cur) return;
        saveEntry_(cur);
        deleteDraft_(cur.id);
        saved = true;
      });
      if (saved) editMessage_(d.chatId, d.msgId, `✅ Auto-saved after ${DRAFT_TTL_HOURS}h\n\n` + summary_(d.result, d));
    } catch (err) {
      Logger.log('autoSave error for ' + d.id + ': ' + (err.stack || err)); // retried next hour
    }
  }

  // Album bookkeeping older than 2 hours is no longer needed
  const props = PROPS.getProperties();
  Object.keys(props).filter(k => k.indexOf('ALBUM_') === 0).forEach(k => {
    try {
      if (Date.now() - JSON.parse(props[k]).created > 2 * 3600 * 1000) PROPS.deleteProperty(k);
    } catch (_) { PROPS.deleteProperty(k); }
  });
}

/** After each analysis: settles when the food was eaten and which meal it belongs to. */
function finalizeResult_(d, prev) {
  const r = d.result;
  const sent = parseLocal_(d.timestamp) || new Date();
  // A correction that doesn't mention the time keeps the time already settled
  let eaten = parseLocal_(r.eaten_at) || (prev ? parseLocal_(prev.eaten_at) : null);
  if (eaten && eaten.getTime() > sent.getTime() + 5 * 60 * 1000) {
    (r.warnings = r.warnings || []).push("That eaten time is after you sent the message, so I used the time you sent it.");
    eaten = null;
  }
  eaten = eaten || sent;
  r.eaten_at = fmtLocal_(eaten);
  r.meal = normalizeMeal_(r.meal);

  // Unless you named the meal, the label comes from MEAL_TIMES. Food eaten within MEAL_WINDOW_MIN of
  // your last entry continues that entry's meal (the window rolls forward with each entry, so dessert
  // at 8:15 stays Dinner), but a Snack never pulls a meal-time entry into Snack.
  const key = 'LAST_MEAL_' + d.chatId;
  const last = JSON.parse(PROPS.getProperty(key) || 'null');
  const explicit = r.meal_explicit === true || r.meal_explicit === 'true';
  if (!explicit) {
    if (prev && prev.meal && prev.eaten_at === r.eaten_at) {
      r.meal = prev.meal; // a correction that didn't touch the meal or time keeps the label
    } else if (last && last.id !== d.id && last.meal !== 'Snack' &&
               Math.abs(eaten.getTime() - last.at) <= MEAL_WINDOW_MIN * 60 * 1000) {
      r.meal = last.meal;
    } else {
      r.meal = mealForTime_(eaten);
    }
  }
  if (!last || last.id === d.id || eaten.getTime() >= last.at) {
    PROPS.setProperty(key, JSON.stringify({ id: d.id, meal: r.meal, at: eaten.getTime() }));
  }
}

/** The MEAL_TIMES label for a time of day, or Snack outside them. */
function mealForTime_(date) {
  const hm = Utilities.formatDate(date, tz_(), 'HH:mm');
  const slot = MEAL_TIMES.find(t => hm >= t.from && hm <= t.to);
  return slot ? slot.meal : 'Snack';
}

function normalizeMeal_(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['Breakfast', 'Lunch', 'Dinner', 'Snack'].find(m => m.toLowerCase() === v) || 'Snack';
}

/** "2026-10-11 15:02" (or with seconds) in the script's time zone → Date; anything else → null. */
function parseLocal_(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  try {
    return Utilities.parseDate(`${m[1]} ${('0' + m[2]).slice(-2)}:${m[3]}`, tz_(), 'yyyy-MM-dd HH:mm');
  } catch (_) { return null; }
}
function fmtLocal_(date) { return Utilities.formatDate(date, tz_(), 'yyyy-MM-dd HH:mm'); }

function photoIds_(d) { return d.photoFileIds || []; }
function saveDraftObj_(d) { PROPS.setProperty('DRAFT_' + d.id, JSON.stringify(d)); }
function getDraft_(id) { const s = PROPS.getProperty('DRAFT_' + id); return s ? JSON.parse(s) : null; }
function deleteDraft_(id) { PROPS.deleteProperty('DRAFT_' + id); }
function allDrafts_() {
  const p = PROPS.getProperties();
  return Object.keys(p).filter(k => k.indexOf('DRAFT_') === 0).map(k => JSON.parse(p[k]));
}

function draftButtons_(id) {
  return {
    inline_keyboard: [[
      { text: '✅ Save', callback_data: 'save:' + id },
      { text: '✏️ Edit', callback_data: 'edit:' + id },
      { text: '🗑 Discard', callback_data: 'discard:' + id }
    ]]
  };
}

// =============== ANALYSIS ===============

function analyze_(d) {
  const ids = photoIds_(d);
  let prompt = buildPrompt_(ids.length, d.timestamp, d.description);
  if (d.corrections.length && d.result) {
    prompt += `

Your previous analysis of this entry was:
${JSON.stringify(d.result)}

The user has corrected it (most recent last). Some corrections add photos; every attached photo is of this meal.
${d.corrections.map((c, i) => `${i + 1}. "${c}"`).join('\n')}

Apply every correction and return the complete revised JSON in the same schema, including the full "items" list. The user's corrections override anything inferred from the photos or description (e.g. a stated weight replaces your estimate). Ignore the "used" and "used_short" fields above; the bot redoes the database lookups.`;
  }
  const parts = [{ text: prompt }];
  ids.forEach(fid => parts.push({ inline_data: { mime_type: 'image/jpeg', data: getPhotoBase64_(fid) } }));
  return enrichWithDatabases_(callGemini_(parts, !d.noSearch));
}

function buildPrompt_(photoCount, timestamp, userDescription) {
  const input = photoCount === 0
    ? 'Text-only description.'
    : photoCount === 1
      ? 'One photo with an optional caption.'
      : `${photoCount} photos, all of the SAME meal (for example a menu or package plus the plate). Use every photo together, and don't count the same food twice if it appears in more than one photo.`;

  return `Analyze this food entry.
Input: ${input}
Sent at: "${timestamp}" (the user's local time).
User context/description: "${userDescription || 'No extra context provided.'}".

NUTRITION SOURCES — break the meal into its separate items, then for EACH item work in this order:
1. If the item comes from a restaurant, chain, or packaged brand named in the text or visible in a photo (menu, packaging, cup, bag, receipt), ${USE_GOOGLE_SEARCH ? 'search the web for' : 'use'} its OFFICIAL nutrition information: the restaurant's or manufacturer's own website, nutrition guide or PDF, or calories printed on the menu or label. Match the specific item and size. If found, use those numbers, set "source" to "official" and "official_site" to the site.
2. Otherwise set "source" to "lookup". The bot will look the item up in USDA FoodData Central (and Open Food Facts for packaged products) using your "lookup_query" and "grams", so make the query a plain database-style name with the preparation, e.g. "white rice cooked", "chicken breast grilled", "cheddar cheese", "banana raw". For a packaged product, use brand plus product, e.g. "Clif Bar chocolate chip". If a barcode number is readable in a photo, put its digits in "barcode".
3. Always fill in your own best per-item numbers too; they are used if no database match is found.
If a Nutrition Facts label is readable in a photo, use it for that item: "source" "official", "official_site" "Nutrition label".
For "barcode", copy only the digits printed under the bars, exactly as printed; leave it empty if any digit is unclear.
Don't search the web for generic or home-cooked foods. Never name a source you did not actually use.

WHEN EATEN: assume the food was eaten when the message was sent. If the user says when they ate it ("ate this at noon", "yesterday's dinner", "breakfast at 7:30"), set "eaten_at" to that local date and time as "YYYY-MM-DD HH:MM", worked out from the sent time. Otherwise "eaten_at" is an empty string. Never give a time after the sent time.

MEAL: if the user's words name the meal (e.g. "this is lunch", "still at dinner", "afternoon snack", "brunch" = Breakfast), set "meal" to it and "meal_explicit" to true. Otherwise set "meal_explicit" to false; the bot picks the meal from the time eaten.

PER-ITEM HEALTH: rate every item on its own, for the portion eaten. "health_score" is a whole number from 1 (least healthy) to 10 (most healthy) for that item alone, with a short reason in "health_note".

LOCATION: Default to "Home". Use "Restaurant" or "Other" only when the user's text says where the food is from, or a photo clearly shows it (a restaurant menu, branded packaging, cup or bag, a receipt). A plain plate of food with no such evidence is "Home". Use "Delivery" when the text or a photo shows the food was delivered from a restaurant (e.g. DoorDash, Uber Eats, Grubhub, a delivery bag or receipt); for Delivery, as for Restaurant, "location_name" is the restaurant's name.

Return ONLY valid JSON (no markdown fences, no text before or after) matching this schema:
{
  "meal": "Breakfast, Lunch, Dinner, or Snack if the user named it, else empty string",
  "meal_explicit": true or false (see MEAL),
  "eaten_at": "YYYY-MM-DD HH:MM if the user said when they ate it, else empty string",
  "food_info": "Summary description of the meal and items identified",
  "location": "Exactly one of: Home, Restaurant, Delivery, Other. Restaurant = restaurant, cafe, bar, or takeout from one. Delivery = delivered from a restaurant. Other = events, someone else's home, work, travel, etc.",
  "location_name": "For Restaurant or Delivery, the restaurant's name; for Other, the event, venue, or host (e.g. Portillo's, Cubs game, Sarah's house). From the text or visible in a photo. Empty string if Home or not known.",
  "items": [
    {
      "name": "short item name as eaten, e.g. Italian beef sandwich",
      "grams": number (estimated weight of the portion eaten, as served/cooked),
      "source": "official or lookup",
      "official_site": "site used if official, else empty string",
      "lookup_query": "database-style search name (see rule 2)",
      "packaged": true or false (a branded packaged product),
      "barcode": "digits if readable in a photo, else empty string",
      "calories": number,
      "protein_g": number,
      "carbs_g": number,
      "fat_g": number,
      "health_score": whole number 1-10 for this item,
      "health_note": "brief reason for the item's score"
    }
  ],
  "calories": number (total of all items),
  "protein_g": number,
  "carbs_g": number,
  "fat_g": number,
  "confidence": "High, Medium, or Low",
  "other_comments": "Assumptions regarding hidden cooking fats, dressings, portion size, or missing items"
}`;
}

function pickPhoto_(photos) {
  // Second-largest size keeps download + inference fast
  return photos.length > 2 ? photos[photos.length - 2] : photos[photos.length - 1];
}

function getPhotoBase64_(fileId) {
  const fileRes = UrlFetchApp.fetch(`${tgBase_()}/getFile?file_id=${fileId}`);
  const filePath = JSON.parse(fileRes.getContentText()).result.file_path;
  const blob = UrlFetchApp.fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`).getBlob();
  return Utilities.base64Encode(blob.getBytes());
}

/** Calls Gemini with Google Search; if search isn't available or the reply isn't usable, retries without it. */
function callGemini_(parts, allowSearch) {
  const modes = USE_GOOGLE_SEARCH && allowSearch !== false ? [true, false] : [false];
  let lastErr = null;

  for (const withSearch of modes) {
    const payload = { contents: [{ parts: parts }] };
    if (withSearch) {
      payload.tools = [{ google_search: {} }];
    } else {
      payload.generationConfig = { response_mime_type: 'application/json' };
    }

    const res = UrlFetchApp.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': GEMINI_API_KEY },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    const code = res.getResponseCode();
    const raw = res.getContentText();

    if (code !== 200) {
      lastErr = new Error(`Gemini ${code}: ${raw.slice(0, 300)}`);
      // 400/403 with search usually means search isn't allowed for this key or request: retry without it
      if (withSearch && (code === 400 || code === 403)) {
        Logger.log('Search request rejected, retrying without search: ' + raw.slice(0, 300));
        continue;
      }
      throw lastErr;
    }

    try {
      const body = JSON.parse(raw);
      const cand = body.candidates[0];
      const text = (cand.content.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
      if (!text) throw new Error('Empty Gemini response: ' + raw.slice(0, 300));
      const result = extractJson_(text);

      // Show which sites the search actually consulted
      const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
      const sites = [...new Set(chunks.map(c => c.web && c.web.title).filter(Boolean))].slice(0, 3);
      result.searched_sites = sites;
      return result;
    } catch (err) {
      lastErr = err;
      if (withSearch) { Logger.log('Unusable search reply, retrying without search: ' + err); continue; }
      throw err;
    }
  }
  throw lastErr;
}

function extractJson_(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON in Gemini reply: ' + clean.slice(0, 200));
  return JSON.parse(clean.slice(start, end + 1));
}

// =============== NUTRITION DATABASES (USDA FoodData Central, Open Food Facts) ===============

/**
 * For every item without official numbers, looks it up (USDA, then Open Food Facts for packaged
 * products), scales the per-100g values to the item's grams, and recomputes the meal totals.
 * If no plausible match is found, Gemini's own estimate for that item is kept.
 */
function enrichWithDatabases_(r) {
  if (!Array.isArray(r.items) || !r.items.length) {
    r.estimation_source = withSearched_('Estimate', r);
    return r;
  }

  r.warnings = [];
  r.items.forEach(it => {
    normalizeItemRatings_(it);
    it.grams = Math.round(Number(it.grams) || 0);
    if (it.barcode) {
      const code = normalizeBarcode_(String(it.barcode).replace(/\D/g, ''));
      if (!code) r.warnings.push(`Couldn't read the barcode on "${it.name}" reliably. Use /scan or type the number for an exact match.`);
      it.barcode = code || '';
    }
    ['calories', 'protein_g', 'carbs_g', 'fat_g'].forEach(k => { it[k] = Number(it[k]) || 0; });

    if (it.source === 'official') {
      it.used = 'Official' + (it.official_site ? ': ' + it.official_site : '');
      it.used_short = 'Official';
      return;
    }
    it.used = 'Estimate';
    it.used_short = 'Estimate';
    if (!it.grams) return; // can't scale a database value without a weight

    let match = null;
    try { match = lookupItem_(it); } catch (err) { Logger.log('Lookup failed for ' + it.name + ': ' + err); }
    if (!match) return;

    const f = it.grams / 100;
    const kcal = match.kcal * f;
    // Reasonableness check: a database value wildly different from the visual estimate usually means a bad match
    if (!match.exact && it.calories > 0 && (kcal / it.calories > 3 || kcal / it.calories < 1 / 3)) {
      it.used = `Estimate (rejected ${match.db} match "${match.desc}" as implausible)`;
      return;
    }
    it.calories = Math.round(kcal);
    it.protein_g = round1_(match.protein * f);
    it.carbs_g = round1_(match.carbs * f);
    it.fat_g = round1_(match.fat * f);
    it.used = match.exact ? `${match.db} barcode ${it.barcode}: ${match.desc}` : `${match.db}: ${match.desc}`;
    it.used_short = match.exact ? match.db + ' barcode' : match.db;
  });

  const sum = k => r.items.reduce((a, it) => a + (Number(it[k]) || 0), 0);
  r.calories = Math.round(sum('calories'));
  r.protein_g = round1_(sum('protein_g'));
  r.carbs_g = round1_(sum('carbs_g'));
  r.fat_g = round1_(sum('fat_g'));

  // e.g. "Official: chipotle.com (1) · USDA (2) · Estimate (1)"
  const counts = {};
  r.items.forEach(it => {
    const label = it.used_short === 'Official' && it.official_site ? 'Official: ' + it.official_site : it.used_short;
    counts[label] = (counts[label] || 0) + 1;
  });
  const rank = k => ['Official', 'USDA', 'Open Food Facts', 'Estimate'].findIndex(x => k.indexOf(x) === 0);
  const labels = Object.keys(counts).sort((a, b) => rank(a) - rank(b));
  r.estimation_source = withSearched_(labels.map(k => `${k} (${counts[k]})`).join(' · '), r);
  return r;
}

/** Keeps per-item health fields in the shapes the Sheet expects. */
function normalizeItemRatings_(it) {
  const score = Math.round(Number(it.health_score));
  it.health_score = score >= 1 && score <= 10 ? score : '';
  it.health_note = String(it.health_note || '');
}

function withSearched_(text, r) {
  return r.searched_sites && r.searched_sites.length ? `${text} · searched: ${r.searched_sites.join(', ')}` : text;
}

/** Order: barcode (USDA, then Open Food Facts), USDA by name, Open Food Facts by name. Cached 6h. */
function lookupItem_(it, skipCache) {
  const q = String(it.lookup_query || it.name || '').trim();
  if (!q) return null;
  const barcode = it.barcode ? normalizeBarcode_(String(it.barcode).replace(/\D/g, '')) : null;
  const cache = CacheService.getScriptCache();
  const key = 'lk_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, [q.toLowerCase(), !!it.packaged, barcode].join('|')));
  if (!skipCache) {
    const hit = cache.get(key);
    if (hit) return hit === 'none' ? null : JSON.parse(hit);
  }

  let m = barcode ? lookupBarcode_(barcode) : null; // exact product match
  if (USE_USDA && !m) m = usdaSearch_(q, it.packaged ? ['Branded'] : ['Foundation', 'SR Legacy', 'Survey (FNDDS)'], true);
  if (USE_OPEN_FOOD_FACTS && it.packaged && !m) m = offSearch_(q);

  cache.put(key, m ? JSON.stringify(m) : 'none', 6 * 3600);
  return m;
}

function fdcKey_() {
  return (typeof FDC_API_KEY !== 'undefined' && FDC_API_KEY) ? FDC_API_KEY : 'DEMO_KEY';
}

/** USDA FoodData Central search. Returns per-100g values for the first plausible hit. */
function usdaSearch_(query, dataTypes, requireWords) {
  const res = UrlFetchApp.fetch(
    'https://api.nal.usda.gov/fdc/v1/foods/search?api_key=' + encodeURIComponent(fdcKey_()), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ query: query, dataType: dataTypes, pageSize: 10 }),
      muteHttpExceptions: true
    });
  if (res.getResponseCode() !== 200) {
    Logger.log(`USDA ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}`);
    return null;
  }
  const foods = JSON.parse(res.getContentText()).foods || [];
  for (const food of foods) {
    const label = [food.description, food.brandName, food.brandOwner].filter(Boolean).join(' ');
    if (requireWords && !containsAllWords_(label, query)) continue;
    const n = usdaNutrients_(food);
    if (n) {
      const brand = food.brandName || food.brandOwner;
      return Object.assign({ db: 'USDA', desc: (brand ? brand + ' ' : '') + food.description }, n);
    }
  }
  return null;
}

/** Pulls kcal/protein/carbs/fat per 100g from a USDA search result. */
function usdaNutrients_(food) {
  const list = food.foodNutrients || [];
  const find = pred => list.find(x => typeof x.value === 'number' && pred(x));
  const num = x => String(x.nutrientNumber || '');
  const energy =
    find(x => (num(x) === '208' || x.nutrientId === 1008) && /kcal/i.test(x.unitName || '')) ||
    find(x => ['957', '958'].includes(num(x)) || [2047, 2048].includes(x.nutrientId)) ||
    find(x => (num(x) === '268' || x.nutrientId === 1062) && /kj/i.test(x.unitName || ''));
  if (!energy) return null;
  const kcal = /kj/i.test(energy.unitName || '') ? energy.value / 4.184 : energy.value;
  const val = (nums, ids) => { const x = find(y => nums.includes(num(y)) || ids.includes(y.nutrientId)); return x ? x.value : 0; };
  return {
    kcal: kcal,
    protein: val(['203'], [1003]),
    fat: val(['204'], [1004]),
    carbs: val(['205'], [1005])
  };
}

/** Open Food Facts name search (packaged products only). */
function offSearch_(query) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_simple=1&action=process&json=1&page_size=5' +
    '&fields=product_name,brands,nutriments&search_terms=' + encodeURIComponent(query);
  const res = UrlFetchApp.fetch(url,
    { muteHttpExceptions: true, headers: { 'User-Agent': 'NutritionBotLite/1.0 (personal Telegram bot)' } });
  if (res.getResponseCode() !== 200) {
    Logger.log(`Open Food Facts ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}`);
    return null;
  }
  const products = JSON.parse(res.getContentText()).products || [];
  for (const p of products) {
    if (!containsAllWords_([p.product_name, p.brands].filter(Boolean).join(' '), query)) continue;
    const m = offNutrients_(p);
    if (m) return m;
  }
  return null;
}

function offNutrients_(p) {
  const n = (p && p.nutriments) || {};
  let kcal = Number(n['energy-kcal_100g']);
  if (!kcal && n['energy_100g']) kcal = Number(n['energy_100g']) / 4.184; // kJ
  const sq = Number(p && p.serving_quantity);
  if (!kcal && sq && n['energy-kcal_serving']) {
    // Only per-serving values listed: convert to per 100 g
    const f = 100 / sq;
    ['proteins', 'carbohydrates', 'fat'].forEach(k => {
      if (n[k + '_100g'] == null && n[k + '_serving'] != null) n[k + '_100g'] = Number(n[k + '_serving']) * f;
    });
    kcal = Number(n['energy-kcal_serving']) * f;
  }
  if (!kcal) return null;
  return {
    db: 'Open Food Facts',
    desc: [p.brands, p.product_name].filter(Boolean).join(' '),
    kcal: kcal,
    servingGrams: Number(p.serving_quantity) || 0,
    servingText: p.serving_size || '',
    protein: Number(n['proteins_100g']) || 0,
    carbs: Number(n['carbohydrates_100g']) || 0,
    fat: Number(n['fat_100g']) || 0
  };
}

/** True if the meaningful words of the query (singular or plural) appear in the label. */
function containsAllWords_(label, query) {
  const stop = ['and', 'with', 'the', 'of', 'in'];
  const hay = String(label).toLowerCase();
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && stop.indexOf(w) === -1);
  const missing = words.filter(w => !(hay.includes(w) || hay.includes(w.replace(/(es|s)$/, '')))).length;
  return missing <= (words.length >= 4 ? 1 : 0); // longer names may drop one word (e.g. "bar")
}

function round1_(x) { return Math.round(x * 10) / 10; }

/** Run from the editor to confirm the database lookups work. Check the Execution log. */
function testLookups() {
  const samples = [
    { name: 'rice', lookup_query: 'white rice cooked', grams: 100, packaged: false },
    { name: 'banana', lookup_query: 'banana raw', grams: 118, packaged: false },
    { name: 'Clif bar', lookup_query: 'Clif Bar chocolate chip', grams: 68, packaged: true },
    { name: 'Nutella', lookup_query: 'Nutella hazelnut spread', grams: 37, packaged: true, barcode: '3017620422003' }
  ];
  Logger.log('USDA key in use: ' + (fdcKey_() === 'DEMO_KEY' ? 'DEMO_KEY (add FDC_API_KEY to Config.gs)' : 'your key'));
  samples.forEach(it => Logger.log(`${it.lookup_query} → ${JSON.stringify(lookupItem_(it, true))}`));
  ['3017620422003'].forEach(code => {
    CacheService.getScriptCache().remove('bc_' + code);
    Logger.log(`barcode ${code} → ${JSON.stringify(lookupBarcode_(code))}`);
  });
  Logger.log('Check digit test (should be true, false): ' + !!normalizeBarcode_('3017620422003') + ', ' + !!normalizeBarcode_('3017620422004'));
}

// =============== BARCODES ===============

/** Typed barcode (scanner, typed number, or photo): validate, look up, then create a draft or add to one. */
function handleBarcode_(msg, rawCode, note) {
  const chatId = msg.chat.id;
  const code = normalizeBarcode_(String(rawCode || '').replace(/\D/g, ''));
  if (!code) {
    sendTelegramMessage(chatId, `⚠️ ${rawCode} doesn't look like a valid barcode (a digit may be off). Scan again or type the number.`);
    return;
  }
  sendChatAction_(chatId, 'typing');
  const match = lookupBarcode_(code);
  if (!match) {
    sendTelegramMessage(chatId,
      `🔎 Barcode ${code} isn't in USDA or Open Food Facts.\nSend a photo of the Nutrition Facts label (or the product name) and I'll log it from that.`);
    return;
  }

  const block = barcodeBlock_(code, match, note);
  const target = findDraftToCorrect_(chatId, msg);
  if (target) {
    reviseDraft_(target, 'Add this packaged product to the meal as a new item and keep the existing items.\n' + block);
  } else {
    createDraft_({ chatId: chatId, date: msg.date, description: block, fileIds: [], noSearch: true });
  }
}

/** Tells Gemini exactly what the product is; the bot recomputes the numbers from the database. */
function barcodeBlock_(code, m, note) {
  const serving = m.servingGrams
    ? `${Math.round(m.servingGrams)} g${m.servingText ? ` ("${m.servingText}")` : ''}`
    : 'not listed (use a typical single serving)';
  return `BARCODE SCAN, exact product match (barcode ${code}):
Product: ${m.desc} (${m.db})
Label serving: ${serving}
Per 100 g: ${Math.round(m.kcal)} kcal, ${round1_(m.protein)} g protein, ${round1_(m.carbs)} g carbs, ${round1_(m.fat)} g fat.
Return one item for this product with "barcode": "${code}", "packaged": true, "source": "lookup".
Portion: exactly ONE label serving unless the user's note says otherwise (e.g. "2 servings" = double, "half the bag", "40g"). Put the resulting weight in "grams".
Location: Home unless the user's note says otherwise.
User note: "${note || 'none'}"`;
}

/** Exact product lookup by barcode: USDA branded foods, then Open Food Facts. Cached 6h. */
function lookupBarcode_(code) {
  const cache = CacheService.getScriptCache();
  const key = 'bc_' + code;
  const hit = cache.get(key);
  if (hit) return hit === 'none' ? null : JSON.parse(hit);

  let m = null;
  try { if (USE_USDA) m = usdaByBarcode_(code); } catch (err) { Logger.log('USDA barcode error: ' + err); }
  try { if (!m && USE_OPEN_FOOD_FACTS) m = offByBarcode_(code); } catch (err) { Logger.log('OFF barcode error: ' + err); }
  if (m) m.exact = true;

  cache.put(key, m ? JSON.stringify(m) : 'none', 6 * 3600);
  return m;
}

/** The same product can be stored as 12, 13 or 14 digits (leading zeros). */
function barcodeVariants_(code) {
  const core = code.replace(/^0+/, '');
  return [code].concat([12, 13, 14].map(n => core.padStart(n, '0'))).filter((v, i, a) => v.length >= 8 && a.indexOf(v) === i);
}

function usdaByBarcode_(code) {
  const want = code.replace(/^0+/, '');
  for (const q of barcodeVariants_(code)) {
    const res = UrlFetchApp.fetch(
      'https://api.nal.usda.gov/fdc/v1/foods/search?api_key=' + encodeURIComponent(fdcKey_()), {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ query: q, dataType: ['Branded'], pageSize: 10 }),
        muteHttpExceptions: true
      });
    if (res.getResponseCode() !== 200) {
      Logger.log(`USDA ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}`);
      return null;
    }
    const foods = JSON.parse(res.getContentText()).foods || [];
    const food = foods.find(f => String(f.gtinUpc || '').replace(/\D/g, '').replace(/^0+/, '') === want);
    if (!food) continue;
    const n = usdaNutrients_(food);
    if (!n) continue;
    const unit = String(food.servingSizeUnit || '').toLowerCase();
    const grams = /^(g|grm|gram)/.test(unit) || /^(ml|mlt)/.test(unit) ? Number(food.servingSize) || 0 : 0;
    const brand = food.brandName || food.brandOwner;
    return Object.assign({
      db: 'USDA',
      desc: (brand ? brand + ' ' : '') + food.description,
      servingGrams: grams,
      servingText: food.householdServingFullText || ''
    }, n);
  }
  return null;
}

function offByBarcode_(code) {
  for (const v of barcodeVariants_(code).slice(0, 2)) {
    const res = UrlFetchApp.fetch(
      `https://world.openfoodfacts.org/api/v2/product/${v}.json?fields=product_name,brands,nutriments,serving_quantity,serving_size`,
      { muteHttpExceptions: true, headers: { 'User-Agent': 'NutritionBotLite/1.0 (personal Telegram bot)' } });
    if (res.getResponseCode() !== 200) continue;
    const body = JSON.parse(res.getContentText());
    if (body.status === 1) {
      const m = offNutrients_(body.product);
      if (m) return m;
    }
  }
  return null;
}

/** Returns a valid barcode (UPC-E expanded to UPC-A), or null if the check digit fails. */
function normalizeBarcode_(d) {
  if (!/^\d+$/.test(d || '')) return null;
  if (d.length === 8) {
    if (/^[01]/.test(d)) {
      const a = expandUpcE_(d);
      if (a && isValidGtin_(a)) return a;
    }
    return isValidGtin_(d) ? d : null;
  }
  return [12, 13, 14].indexOf(d.length) !== -1 && isValidGtin_(d) ? d : null;
}

/** Standard GTIN check digit (UPC-A, EAN-8, EAN-13, GTIN-14). */
function isValidGtin_(code) {
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

/** UPC-E (8 digits) to UPC-A (12 digits). */
function expandUpcE_(e) {
  const ns = e[0], d = e.slice(1, 7), chk = e[7];
  const last = d[5];
  let body;
  if ('012'.indexOf(last) !== -1) body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
  else body = d.slice(0, 5) + '0000' + last;
  return ns + body + chk;
}

/** "012345678905", "0 12345 67890 5" or "012345678905 2 servings" → {code, note}; bad check digit → {invalid}. */
function parseTypedBarcode_(text) {
  const tokens = text.trim().split(/\s+/);
  const lead = [];
  for (const t of tokens) {
    if (/^[\d-]+$/.test(t)) lead.push(t.replace(/-/g, '')); else break;
  }
  const all = lead.join('');
  if (all.length < 8) return null; // ordinary text like "2 eggs" or "100 g chicken"
  for (let k = 1; k <= lead.length; k++) { // shortest valid prefix wins, so "… 2 servings" stays a note
    const joined = lead.slice(0, k).join('');
    const code = joined.length >= 8 ? normalizeBarcode_(joined) : null;
    if (code) return { code: code, note: tokens.slice(k).join(' ') };
  }
  return { invalid: all };
}

/** Persistent "Scan barcode" button that opens the scanner page served by the Cloudflare Worker. */
function scanKeyboard_() {
  return {
    keyboard: [[{ text: '📷 Scan barcode', web_app: { url: String(WORKER_URL).replace(/\/+$/, '') + '/scan' } }]],
    resize_keyboard: true,
    is_persistent: true
  };
}

// =============== SHEET & MESSAGES ===============

const ITEM_HEADERS = ['Eaten At', 'Logged At', 'Meal', 'Entry ID', 'Item', 'Grams', 'Calories', 'Protein', 'Carbs',
  'Fat', 'Source', 'Location', 'Location Name', 'Health Score', 'Health Note',
  'Confidence', 'Notes'];
const LOCATIONS = ['Home', 'Restaurant', 'Delivery', 'Other', 'Unknown'];

/** The Items tab, created with headers, date formats and a Location dropdown the first time. */
function itemsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ITEMS_TAB);
  if (sheet) return sheet;
  sheet = ss.insertSheet(ITEMS_TAB);
  sheet.getRange(1, 1, 1, ITEM_HEADERS.length).setValues([ITEM_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A2:B').setNumberFormat('yyyy-mm-dd hh:mm');
  const locCol = ITEM_HEADERS.indexOf('Location') + 1;
  sheet.getRange(2, locCol, sheet.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(LOCATIONS, true).build());
  return sheet;
}

/** Saves a draft: one row per food item. Entry-level notes go on the first row only. */
function saveEntry_(d) {
  const r = d.result;
  const eaten = parseLocal_(r.eaten_at) || parseLocal_(d.timestamp) || new Date();
  const items = Array.isArray(r.items) && r.items.length ? r.items : [{
    name: r.food_info, calories: r.calories, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g,
    used: r.estimation_source
  }];
  const notes = [
    r.other_comments,
    Array.isArray(r.warnings) ? r.warnings.join(' ') : ''
  ].filter(Boolean).join('\n');
  const n = x => Number(x) || 0;
  const rows = items.map((it, i) => [
    eaten, new Date(), normalizeMeal_(r.meal), d.id, it.name || '', it.grams || '',
    Math.round(n(it.calories)), n(it.protein_g), n(it.carbs_g), n(it.fat_g),
    it.used || 'Estimate',
    normalizeLocation_(r.location), r.location_name || '', it.health_score || '', it.health_note || '',
    r.confidence || '', i === 0 ? notes : ''
  ]);
  const sheet = itemsSheet_();
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
}

/** "Lunch today so far: 4 items, ~820 kcal", counting saved items plus this entry. Empty if this is the first. */
function mealSoFar_(d) {
  try {
    const r = d.result;
    const eaten = parseLocal_(r.eaten_at);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ITEMS_TAB);
    if (!eaten || !sheet || sheet.getLastRow() < 2) return '';
    const tz = tz_();
    const day = Utilities.formatDate(eaten, tz, 'yyyy-MM-dd');
    const first = Math.max(2, sheet.getLastRow() - 499); // recent rows are enough
    const rows = sheet.getRange(first, 1, sheet.getLastRow() - first + 1, 7).getValues();
    let count = 0, kcal = 0;
    rows.forEach(v => {
      if (v[3] === d.id || !(v[0] instanceof Date) || v[2] !== r.meal) return;
      if (Utilities.formatDate(v[0], tz, 'yyyy-MM-dd') !== day) return;
      count++;
      kcal += Number(v[6]) || 0;
    });
    if (!count) return '';
    const mine = Array.isArray(r.items) && r.items.length ? r.items.length : 1;
    const when = day === Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') ? 'today' : Utilities.formatDate(eaten, tz, 'EEE MMM d');
    return `🍽 ${r.meal} ${when} so far: ${count + mine} items, ~${Math.round(kcal + (Number(r.calories) || 0))} kcal`;
  } catch (err) {
    Logger.log('mealSoFar_ error: ' + err);
    return '';
  }
}

/** Always one of the Sheet dropdown values; anything unrecognized becomes Home. */
function normalizeLocation_(value) {
  const v = String(value || '').trim().toLowerCase();
  return LOCATIONS.find(a => a.toLowerCase() === v) || 'Home';
}

function summary_(r, d) {
  const loc = normalizeLocation_(r.location) + (r.location_name ? ' – ' + r.location_name : '');
  const eaten = parseLocal_(r.eaten_at);
  const when = eaten ? ' · ' + Utilities.formatDate(eaten, tz_(), 'EEE MMM d, h:mm a') : '';
  const items = Array.isArray(r.items) && r.items.length
    ? 'Items:\n' + r.items.map(it => {
        const health = it.health_score ? ` · Health ${it.health_score}/10` : '';
        return `• ${it.name}${it.grams ? ` (${it.grams}g)` : ''} – ${Math.round(Number(it.calories) || 0)} kcal · ${it.used_short || 'Estimate'}${health}`;
      }).join('\n') + '\n'
    : '';
  const soFar = d ? mealSoFar_(d) : '';
  return `Meal: ${r.meal}${when}\n` +
    `Item: ${r.food_info}\n` +
    `Location: ${loc}\n` +
    `Macros: ~${r.calories} kcal | P: ${r.protein_g}g | C: ${r.carbs_g}g | F: ${r.fat_g}g\n` +
    items +
    `Source: ${r.estimation_source}\n` +
    (Array.isArray(r.warnings) && r.warnings.length ? r.warnings.map(w => '⚠️ ' + w).join('\n') + '\n' : '') +
    `Confidence: ${r.confidence}` +
    (soFar ? '\n\n' + soFar : '');
}

/** Sends a message; returns its message_id (or null). */
function sendTelegramMessage(chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = tgCall_('sendMessage', payload);
  return res && res.ok ? res.result.message_id : null;
}

function editMessage_(chatId, messageId, text) {
  if (!messageId) return;
  tgCall_('editMessageText', {
    chat_id: chatId, message_id: messageId, text: text, reply_markup: { inline_keyboard: [] }
  });
}

function removeButtons_(chatId, messageId) {
  if (!messageId) return;
  tgCall_('editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] }
  });
}

function answerCallback_(callbackId) { tgCall_('answerCallbackQuery', { callback_query_id: callbackId }); }
function sendChatAction_(chatId, action) { tgCall_('sendChatAction', { chat_id: chatId, action: action }); }

function tgCall_(method, payload) {
  const res = UrlFetchApp.fetch(`${tgBase_()}/${method}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  try { return JSON.parse(res.getContentText()); } catch (_) { return null; }
}

// =============== UTILITIES ===============

function markSeen_(updateId) {
  const seen = JSON.parse(PROPS.getProperty('SEEN_IDS') || '[]');
  if (seen.indexOf(updateId) !== -1) return false;
  seen.push(updateId);
  PROPS.setProperty('SEEN_IDS', JSON.stringify(seen.slice(-200)));
  return true;
}

function withLock_(fn) {
  if (LOCK_HELD) return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_HELD = true;
  try {
    return fn();
  } finally {
    LOCK_HELD = false;
    lock.releaseLock();
  }
}

function ok_() { return ContentService.createTextOutput('OK'); }

// =============== RUN THESE MANUALLY FROM THE EDITOR ===============

/**
 * One-click setup (SETUP.md Step 8). Checks your settings, creates the Items tab, connects Telegram
 * to your Cloudflare Worker and starts the hourly auto-save timer. Safe to run again any time:
 * fix anything marked ❌ in the Execution log, then run it again.
 */
function setup() {
  const lines = [];
  const pass = m => lines.push('✅ ' + m);
  const warn = m => lines.push('⚠️ ' + m);
  const fail = m => lines.push('❌ ' + m);
  const finish = () => {
    const bad = lines.some(l => l.indexOf('❌') === 0);
    const locked = typeof ALLOWED_CHAT_ID === 'undefined' || !ALLOWED_CHAT_ID;
    lines.push('', bad ? 'Fix the ❌ items, Save, deploy a new version, then run setup again.'
      : locked ? 'Almost done: finish the last step above.' : 'All set. Send your bot a photo of some food.');
    Logger.log('\n' + lines.join('\n'));
  };

  // 1. Every Config.gs line must exist, even the blank ones
  const cfg = {
    BOT_TOKEN:       typeof BOT_TOKEN       !== 'undefined' ? String(BOT_TOKEN)       : null,
    GEMINI_API_KEY:  typeof GEMINI_API_KEY  !== 'undefined' ? String(GEMINI_API_KEY)  : null,
    ALLOWED_CHAT_ID: typeof ALLOWED_CHAT_ID !== 'undefined' ? String(ALLOWED_CHAT_ID) : null,
    FDC_API_KEY:     typeof FDC_API_KEY     !== 'undefined' ? String(FDC_API_KEY)     : null,
    WEBHOOK_SECRET:  typeof WEBHOOK_SECRET  !== 'undefined' ? String(WEBHOOK_SECRET)  : null,
    WORKER_URL:      typeof WORKER_URL      !== 'undefined' ? String(WORKER_URL)      : null
  };
  const missing = Object.keys(cfg).filter(k => cfg[k] === null);
  if (missing.length) {
    fail(`Config.gs is missing: ${missing.join(', ')}. Copy every line from Config.example.gs, then fill in your values.`);
    return finish();
  }

  // 2. Telegram bot token
  let telegramOk = false;
  if (!cfg.BOT_TOKEN || /^YOUR_/.test(cfg.BOT_TOKEN)) {
    fail('BOT_TOKEN: paste the token from BotFather (Step 1).');
  } else {
    const me = tgCall_('getMe', {});
    if (me && me.ok) { pass(`Telegram bot: @${me.result.username}`); telegramOk = true; }
    else fail('BOT_TOKEN: Telegram rejected it. Copy it from BotFather again.');
  }

  // 3. Gemini key (only reads the model's details; no AI credits are used)
  if (!cfg.GEMINI_API_KEY || /^YOUR_/.test(cfg.GEMINI_API_KEY)) {
    fail('GEMINI_API_KEY: paste your key from Google AI Studio (Step 2).');
  } else {
    const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`,
      { headers: { 'x-goog-api-key': cfg.GEMINI_API_KEY }, muteHttpExceptions: true });
    if (res.getResponseCode() === 200) pass(`Gemini key works (model ${GEMINI_MODEL})`);
    else fail(`GEMINI_API_KEY: Gemini answered ${res.getResponseCode()}. Check the key, or change GEMINI_MODEL at the top of Code.gs if that model was retired.`);
  }
  if (USE_GOOGLE_SEARCH) pass('Restaurant/brand web lookups on (if your Gemini plan refuses them, the bot carries on without)');

  // 4. USDA key (optional)
  if (cfg.FDC_API_KEY) pass('USDA key set');
  else warn('No USDA key: limited to 50 USDA lookups a day. Optional; see Step 3.');

  // 5. Webhook secret and Worker
  let secretOk = false, workerOk = false;
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(cfg.WEBHOOK_SECRET) || cfg.WEBHOOK_SECRET === 'LettersAndNumbersOnly') {
    fail('WEBHOOK_SECRET: make up your own, 20+ letters and numbers with no spaces or symbols (Step 5c).');
  } else { pass('Webhook secret looks good'); secretOk = true; }

  const worker = cfg.WORKER_URL.replace(/\/+$/, '');
  if (!/^https:\/\//.test(worker) || /your-worker|your-subdomain/.test(worker)) {
    fail('WORKER_URL: paste your Cloudflare Worker address (Step 7c).');
  } else {
    let body = '';
    try { body = UrlFetchApp.fetch(worker, { muteHttpExceptions: true }).getContentText(); } catch (_) {}
    if (body.trim() === 'OK') { pass('Cloudflare Worker reachable'); workerOk = true; }
    else fail('WORKER_URL: no answer from the Worker. Check the address and that the Worker code is deployed (Step 7b).');
  }

  // 6. Web app deployment
  if (ScriptApp.getService().getUrl()) pass('Web app deployed (remember: a new version after every change)');
  else fail('The web app isn\'t deployed yet (Step 6).');

  // 7. Time zone and Sheet
  pass(`Time zone: ${tz_()}. If that's wrong, change it in the Sheet under File → Settings.`);
  itemsSheet_();
  pass(`"${ITEMS_TAB}" tab ready`);

  // 8. Connect Telegram to the Worker, start the auto-save timer
  if (telegramOk && secretOk && workerOk) {
    removeTriggers_('pollTelegram');
    const res = tgCall_('setWebhook', { url: worker, secret_token: cfg.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    if (res && res.ok) pass('Telegram now sends messages to your Worker');
    else fail('Telegram couldn\'t connect to the Worker: ' + JSON.stringify(res));
    ensureAutoSaveTrigger_();
    pass(`Untouched drafts auto-save after ${DRAFT_TTL_HOURS} hours`);
  } else {
    warn('Telegram isn\'t connected yet: fix the items above first.');
  }

  // 9. Lock the bot to you
  if (cfg.ALLOWED_CHAT_ID) pass(`Bot answers only chat ${cfg.ALLOWED_CHAT_ID}`);
  else warn('Last step: send /id to your bot, put the number in ALLOWED_CHAT_ID, Save, and deploy a new version (Step 9).');

  finish();
}

/** Worker mode: stops polling, points Telegram at the Worker (messages + button taps), ensures auto-save timer. */
function switchToWorker() {
  removeTriggers_('pollTelegram');
  const res = tgCall_('setWebhook', {
    url: WORKER_URL,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query']
  });
  Logger.log('setWebhook: ' + JSON.stringify(res));
  ensureAutoSaveTrigger_();
}

/** Fallback: polling mode (removes webhook, keeps queued messages, 1-min timer). */
function switchToPolling() {
  Logger.log('deleteWebhook: ' + JSON.stringify(tgCall_('deleteWebhook', { drop_pending_updates: false })));
  removeTriggers_('pollTelegram');
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  ensureAutoSaveTrigger_();
  Logger.log('Polling started: every 1 minute.');
}

function ensureAutoSaveTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'autoSaveDrafts');
  if (!exists) ScriptApp.newTrigger('autoSaveDrafts').timeBased().everyHours(1).create();
  Logger.log('Auto-save check: every hour.');
}

/** Deletes only timers that run the named function. */
function removeTriggers_(handlerName) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handlerName)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Shows webhook status. */
function checkWebhook() {
  Logger.log(JSON.stringify(tgCall_('getWebhookInfo', {})));
}

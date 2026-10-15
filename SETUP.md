# Setup Guide

This guide walks you through building your own copy of Nutrition Bot Lite, step by step. **You don't need to know how to code.** You'll copy and paste a few files and click through some websites. Plan on about an hour.

> **Tip:** Websites change their buttons from time to time. If something here doesn't match what you see, look for a button with a similar name. The steps are the same even when the layout moves around.

---

## What you'll end up with

A private Telegram bot. Send it a photo of your meal, a description ("2 eggs and toast"), or a barcode, and it replies with calories, protein, carbs, fat and a health score. Tap **Save** and it adds the food to a Google Sheet that only you can see, one row per item.

## How the pieces fit together

You'll set up five free accounts (one is optional). Here's what each one does:

| Service | What it does | Cost |
|---|---|---|
| **Telegram** | The chat app where you talk to your bot | Free |
| **Google Gemini** | The AI that looks at your photos and estimates nutrition | Free tier available (see Step 2) |
| **Google Sheets + Apps Script** | Stores your meals, and runs the bot's "brain" | Free |
| **Cloudflare** | A small relay that receives messages from Telegram and hands them to Google. It also hosts the barcode scanner. | Free |
| **USDA FoodData Central** *(optional but recommended)* | A government nutrition database for more accurate numbers | Free |

## Keep a notepad open

Along the way you'll collect several codes and links. Open a blank note (Notes, Notepad, anything) and paste each one in as you get it. You'll need them later.

| Item | Where you get it |
|---|---|
| Telegram bot token | Step 1 |
| Gemini API key | Step 2 |
| USDA API key | Step 3 |
| Webhook secret | Step 5 (you make it up) |
| Apps Script web app URL | Step 6 |
| Cloudflare Worker URL | Step 7 |
| Your chat ID | Step 9 |

> 🔒 **Treat the token and keys like passwords.** Anyone who has them can control your bot or spend your AI credits. Don't post them online or share screenshots that show them. Delete the note when you're done.

---

## Step 1: Create your Telegram bot

1. Install Telegram on your phone ([telegram.org](https://telegram.org)) and create an account if you don't have one.
2. In Telegram, tap the search bar and type **BotFather**. Open the one with a **blue checkmark**. That's Telegram's official tool for making bots.
3. Tap **Start**.
4. Send the message `/newbot`.
5. BotFather asks for a **name**. This is what you'll see in your chat list. For example: `My Nutrition Bot`.
6. BotFather asks for a **username**. It must be unique and end in `bot`. For example: `janes_nutrition_bot`. If it's taken, try another.
7. BotFather replies with a long code that looks like `1234567890:AAH...`. That's your **bot token**. Copy it into your notepad.

## Step 2: Get a Gemini API key (the AI)

1. Go to [aistudio.google.com](https://aistudio.google.com) and sign in with your Google account.
2. Accept the terms if asked.
3. Click **Get API key** (usually in the left sidebar), then **Create API key**.
4. If it asks you to pick a Google Cloud project, let it create a new one.
5. Copy the key (it starts with `AIza`) into your notepad.

**Free or paid?**

- **Free tier:** works for photo and text analysis. However, it **can't** look up official nutrition info on restaurant and brand websites. You'll turn that feature off in Step 5. Note that Google may use free-tier data to improve its products, so your food photos may be reviewed.
- **Paid tier:** turns on restaurant/brand lookups through Google Search. To enable it, click **Set up billing** next to your key in AI Studio and add a payment method. You pay per use; check Google's current Gemini API pricing. **We strongly recommend setting a budget alert** in Google Cloud Billing so there are no surprises.

You can start free and upgrade later.

## Step 3: Get a USDA key (optional, recommended)

The bot works without this key, but it's limited to 50 USDA lookups a day.

1. Go to [api.data.gov/signup](https://api.data.gov/signup).
2. Enter your name and email and submit.
3. Your key arrives by email within a few minutes. Copy it into your notepad.

## Step 4: Create your Google Sheet

1. Go to [sheets.new](https://sheets.new). This creates a blank Google Sheet.
2. Click the title "Untitled spreadsheet" at the top left and rename it, for example `Food Log`.
3. Check the time zone: click **File → Settings** and make sure **Time zone** is yours (Google usually fills it in from your account). The bot uses it to decide what counts as breakfast, lunch or dinner.
4. Click **Save settings**.

That's it. You don't need to type any headers: the first time you save a meal, the bot adds a tab called **Items** with all its columns and a Location dropdown.

## Step 5: Add the bot's code to your Sheet

The bot's "brain" lives inside your Google Sheet, using a free Google tool called Apps Script.

### 5a. Open Apps Script

1. In your Sheet, click **Extensions → Apps Script**. A new tab opens with a code editor.
2. At the top left, click **Untitled project** and rename it, for example `Nutrition Bot`.

### 5b. Paste in the main code

1. In a new browser tab, open this project's [`apps-script/Code.gs`](apps-script/Code.gs) file on GitHub.
2. Click the **Copy raw file** button (two overlapping squares, top right of the code).
3. Go back to the Apps Script tab. You'll see a file called `Code.gs` with a few lines in it. Click inside the code area, select everything (**Ctrl+A** on Windows, **Cmd+A** on Mac), and delete it.
4. Paste (**Ctrl+V** / **Cmd+V**).
5. Click the 💾 **Save** icon.

### 5c. Make your settings file

1. In the left sidebar, next to **Files**, click **+** and choose **Script**.
2. Name it `Config` (Apps Script adds `.gs` for you) and press Enter.
3. Delete anything in the new file.
4. Open [`apps-script/Config.example.gs`](apps-script/Config.example.gs) on GitHub, copy it the same way, and paste it in.
5. Now fill in your values. Replace only the text **between the quote marks**, and keep the quote marks:

   | Setting | What to put |
   |---|---|
   | `BOT_TOKEN` | Your bot token from Step 1 |
   | `GEMINI_API_KEY` | Your Gemini key from Step 2 |
   | `ALLOWED_CHAT_ID` | **Leave blank for now** (`''`). You'll fill it in at Step 9. |
   | `FDC_API_KEY` | Your USDA key from Step 3, or leave blank |
   | `WEBHOOK_SECRET` | **Make one up:** 30 or more random letters and numbers, no spaces or symbols. It should look something like `k38Fh2Lq9ZpX7aWm4TnR1cYv6JsE0dGb`, but don't copy that one. Save it in your notepad. |
   | `WORKER_URL` | Leave as-is for now. You'll fill it in at Step 8. |

   Example of a filled-in line:
   ```
   const BOT_TOKEN       = '1234567890:AAHxyz...';
   ```

6. **If you're on the Gemini free tier:** click on `Code.gs`, find the line `const USE_GOOGLE_SEARCH = true;` near the top, and change `true` to `false`.
7. Click 💾 **Save**.

## Step 6: Publish the bot's brain as a web app

This gives your Apps Script a web address that Cloudflare can send messages to.

1. At the top right of the Apps Script editor, click **Deploy → New deployment**.
2. Next to "Select type," click the ⚙️ gear and choose **Web app**.
3. Fill in:
   - **Description:** anything, for example `v1`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**

   > "Anyone" is needed so Cloudflare can reach it. It's still protected: the code ignores any request that doesn't include your secret from Step 5.
4. Click **Deploy**.
5. Google asks you to **Authorize access**. Click it and choose your Google account.
6. You'll see a warning: **"Google hasn't verified this app."** That's expected, since you're the one who made it. Click **Advanced**, then **Go to Nutrition Bot (unsafe)**, then **Allow**.
7. Copy the **Web app URL**. It ends in `/exec`. Paste it in your notepad.

## Step 7: Set up the Cloudflare relay

Telegram expects an instant reply, and Google is sometimes slow, which makes Telegram resend the same message. The Cloudflare "Worker" answers Telegram right away and passes the message to Google behind the scenes.

### 7a. Create the Worker

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up), create a free account, and verify your email.
2. In the left menu, click **Workers & Pages** (it may be under **Compute**).
3. Click **Create** (or **Create application**), then choose **Start with Hello World!** (or "Create Worker").
4. Name it, for example `nutrition-bot`, and click **Deploy**.
   - If Cloudflare asks you to pick a **workers.dev subdomain**, choose any name. It becomes part of your Worker's address.

### 7b. Paste in the relay code

1. On your Worker's page, click **Edit code**.
2. In the code editor, select everything and delete it.
3. Open [`worker/worker.js`](worker/worker.js) on GitHub, copy it with **Copy raw file**, and paste it in.
4. Click **Deploy** (top right).

### 7c. Add your two secrets

1. Go back to your Worker's page and click **Settings**, then **Variables and Secrets**.
2. Click **Add**. Set **Type** to **Secret**, **Variable name** to `APPS_SCRIPT_URL`, and **Value** to your web app URL from Step 6.
3. Click **Add** again. Set **Type** to **Secret**, **Variable name** to `WEBHOOK_SECRET`, and **Value** to the secret you made up in Step 5. It must match exactly.
4. Click **Deploy** (or **Save and deploy**).
5. Find your Worker's address on its overview page. It looks like `https://nutrition-bot.yourname.workers.dev`. Copy it into your notepad.

## Step 8: Connect everything

1. Go back to Apps Script and open **Config.gs**.
2. Set `WORKER_URL` to your Worker address from Step 7, for example:
   ```
   const WORKER_URL      = 'https://nutrition-bot.yourname.workers.dev';
   ```
3. Click 💾 **Save**.
4. **Publish the change.** This step is easy to miss, and you'll repeat it every time you change anything:
   1. Click **Deploy → Manage deployments**.
   2. Click the ✏️ **pencil** (Edit) icon.
   3. Under **Version**, choose **New version**.
   4. Click **Deploy**.

   > Saving alone does **not** update the live bot. Only a new version does.
5. Now run the setup check. At the top of the editor, open the dropdown next to **Run** and choose **setup**. Then click **▶ Run**.
   - If Google asks for permission again, approve it the same way as in Step 6.
6. An **Execution log** appears at the bottom with a checklist. It tests your bot token, Gemini key and Worker, creates the **Items** tab, connects Telegram to your Worker and starts the auto-save timer.
   - ✅ means that part works.
   - ❌ tells you what to fix. Fix it, click 💾 **Save**, publish a new version (part 4 above), and run **setup** again. You can run it as many times as you like.
   - At this point, one ⚠️ about `ALLOWED_CHAT_ID` is expected. That's the next step.

## Step 9: Lock the bot to just you

Right now the bot answers nobody, which keeps strangers from using up your AI credits. Let's let you in.

1. In Telegram, search for your bot's username and open the chat.
2. Send `/id`. The bot replies with **your chat ID** (a number).
3. In Apps Script **Config.gs**, put that number between the quotes:
   ```
   const ALLOWED_CHAT_ID = '123456789';
   ```
4. Click 💾 **Save**, then publish a **new version** (Step 8, part 4).
5. Optional: run **setup** once more. Every line should now be ✅ (a ⚠️ about the USDA key is fine if you skipped Step 3).

## Step 10: Try it out

1. **Photo:** send your bot a photo of some food. Within about 30 seconds you'll get a draft with nutrition estimates and three buttons:
   - **Save** adds it to your Sheet.
   - **Edit** lets you correct it in plain words, like "it was 2 bananas," "this was at Chipotle," "I ate this at noon," or "this was lunch."
   - **Discard** throws it away. Use this when you just want the info without logging it.

   If you don't tap anything, the draft saves itself after 2 hours.
2. **Text:** send a description, like `turkey sandwich and an apple`.
3. **Barcode:** type the number under a barcode, for example `012345678905`. Add a portion if you like: `012345678905 2 servings`.
4. **Barcode scanner:** send `/scan`. A **📷 Scan barcode** button appears at the bottom of the chat. Tap it to use your camera. If you ate more or less than one serving, type it in the **Portion** box before you scan. As soon as the barcode reads, the scanner closes and the bot sends a draft. Send `/hidescan` to hide the button.
5. **Albums:** send several photos at once to log them as one entry.

Check your Google Sheet. A new **Items** tab appears with one row per food.

### How meals and times work

- **Each food gets its own row,** with its own calories, macros and 1–10 health score.
- **A meal is everything with the same label on the same day.** The label comes from when you ate: breakfast 5–10:30 am, lunch 11 am–2 pm, dinner 5–8:30 pm, and a snack any other time. You can change these times (see "Changing things later").
- **Meals stay together.** Anything eaten within an hour of a breakfast, lunch or dinner entry joins that meal. Each new entry restarts the hour, so a long dinner with dessert at 8:45 stays "Dinner." Snacks don't spread this way: a 4:30 snack won't turn a 5:15 dinner into a snack.
- **You can always override it.** Say "this is lunch" in a caption or an Edit, and that wins.
- **The time eaten** is when you sent the message, unless you say otherwise, like "ate this at noon" or "this was yesterday's dinner."
- **Traveling?** The bot uses your Sheet's time zone, because Telegram doesn't tell it where you are. While you're in another time zone, change it under **File → Settings** so 7 am still counts as breakfast, and change it back when you get home. Entries you've already saved keep the times they were saved with.
- **Running total:** each draft shows how the meal adds up so far, like "Lunch today so far: 3 items, ~640 kcal."

To see totals per meal in your Sheet, use **Insert → Pivot table**. Set Rows to *Eaten At* (grouped by day) and *Meal*, and Values to *SUM of Calories*.

---

## Changing things later

- **Every** change in Apps Script needs a new version: **Deploy → Manage deployments → ✏️ → New version → Deploy**.
- Common settings at the top of `Code.gs`:
  - `DRAFT_TTL_HOURS`: how long before an untouched draft auto-saves (default 2)
  - `MEAL_WINDOW_MIN`: how close together (in minutes) two entries must be to share a meal label (default 60)
  - `MEAL_TIMES`: the start and end times for breakfast, lunch and dinner, in 24-hour time (for example `'18:00'` for 6 pm)
  - `USE_GOOGLE_SEARCH`: official restaurant/brand lookups (needs the paid Gemini tier)
  - `USE_USDA` and `USE_OPEN_FOOD_FACTS`: nutrition database lookups

## Troubleshooting

| Problem | Try this |
|---|---|
| Bot doesn't answer at all | Did you publish a **new version** after your last change? Then run **setup** again and read its checklist. To see what Telegram reports, run **checkWebhook** from the same dropdown. |
| Bot says "Setup isn't finished" | Put your chat ID in `ALLOWED_CHAT_ID` (Step 9) and publish a new version. |
| Bot answers `/id` but nothing else | The chat ID in `ALLOWED_CHAT_ID` doesn't match. Send `/id` again and compare. |
| Error mentioning Gemini `403` or `429` | Your key is wrong, or you hit the free-tier limit. Check the key in Config.gs, or wait a bit. |
| Messages show up twice | Make sure Telegram points at the **Cloudflare Worker**, not directly at Apps Script. Run **setup** again. |
| `/scan` button does nothing, or shows an old version | Check `WORKER_URL` in Config.gs. Then fully close and reopen Telegram, since it caches the scanner page. |
| A setting in Config.gs causes an error | Every line from `Config.example.gs` must be present, even the ones you leave blank. |
| A snack got labeled as lunch (or vice versa) | It was eaten within an hour of a meal, or inside a meal's time window. Tap **Edit** and say "this was a snack." If it keeps happening, adjust `MEAL_TIMES`. Also check the Sheet's time zone under **File → Settings**. |
| The scanner asks for camera access every time (iPhone) | That's Telegram's in-app browser on iPhone, and the bot can't change it. Tap **Allow**, or use **Take a photo of the barcode instead**, which opens your phone's own camera. |
| Times in the Sheet are off by a few hours | The Sheet's time zone is wrong. Fix it under **File → Settings**. New entries use the new zone; entries already saved keep the times they were saved with. |
| USDA lookups stopped working partway through the day | You've used the 50/day demo limit. Add your own key (Step 3). |

## Not working with Gemini?

The bot only supports Google Gemini.

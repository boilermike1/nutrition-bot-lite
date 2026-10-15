// ===================== CONFIG (private) =====================
// In Apps Script, create a file named Config.gs with this content and your REAL values (SETUP.md Step 5c).
// Never share or commit Config.gs. This example file (fake values) is safe to share.
// Keep every line, even the ones you leave blank.

const BOT_TOKEN       = 'YOUR_TELEGRAM_BOT_TOKEN';      // from BotFather (no "bot" prefix)
const GEMINI_API_KEY  = 'YOUR_GEMINI_API_KEY';          // from Google AI Studio
const ALLOWED_CHAT_ID = '';                             // your chat ID (send /id to the bot); blank = bot answers nobody
const FDC_API_KEY     = '';                             // free USDA key from api.data.gov/signup; blank = DEMO_KEY (50/day)

// Must match the WEBHOOK_SECRET stored in your Cloudflare Worker
const WEBHOOK_SECRET  = 'LettersAndNumbersOnly';
const WORKER_URL      = 'https://your-worker.your-subdomain.workers.dev';

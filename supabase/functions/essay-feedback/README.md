# essay-feedback Edge Function

Calls **Google Gemini Flash** to compare a user's LPDP essay against the most
similar awardee (winning) essays from the `reference_essays` table, and returns
structured per-aspect feedback (motivasi / kontribusi / rencana_studi).

The browser never sees the Gemini API key — it's stored as a Supabase secret
and only used server-side.

---

## 1. Get a Gemini API key (free)

1. Go to <https://aistudio.google.com/app/apikey>
2. Click **Create API key** (use a personal Google account — free tier)
3. Copy the key — you'll paste it in step 3 below

The Gemini 2.5 Flash free tier is generous (currently ~1500 requests/day),
which is way more than enough for an LPDP prep app.

## 2. Install Supabase CLI (one-time)

```bash
# macOS
brew install supabase/tap/supabase

# Windows (scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# or via npm (any OS)
npm install -g supabase
```

Then log in and link your project:

```bash
supabase login
supabase link --project-ref <YOUR-PROJECT-REF>
```

(Find `<YOUR-PROJECT-REF>` in your Supabase dashboard URL: `https://supabase.com/dashboard/project/<ref>`.)

## 3. Set the Gemini API key as a secret

```bash
supabase secrets set GEMINI_API_KEY=AIzaSy...your-key
```

(Optional) override the model:

```bash
supabase secrets set GEMINI_MODEL=gemini-2.5-flash
```

## 4. Deploy the function

From the project root:

```bash
supabase functions deploy essay-feedback
```

That's it. The browser code (`App.getAwardeeFeedback` in `js/app.js`) calls
it via `supabase.functions.invoke('essay-feedback', ...)`.

---

## Testing locally (optional)

```bash
supabase functions serve essay-feedback --env-file .env.local
```

Where `.env.local` contains:

```
GEMINI_API_KEY=AIzaSy...your-key
```

Then send a test request:

```bash
curl -X POST http://localhost:54321/functions/v1/essay-feedback \
  -H "Content-Type: application/json" \
  -d '{
    "userEssay": "Saya ingin melanjutkan studi S2 di bidang ...",
    "language": "id",
    "awardeeReferences": [
      { "title": "Awardee 2023", "university": "TU Delft",
        "excerpt": "Sejak SMA saya tertarik dengan ..." }
    ]
  }'
```

## Troubleshooting

- **"GEMINI_API_KEY belum di-set"** — run step 3 above.
- **"Gemini API error 429"** — you hit the free-tier rate limit. Wait a minute or upgrade.
- **"Gemini API error 400"** — usually means the prompt is too long. The function already truncates each awardee excerpt to 2500 chars, but if you have very long user essays this can still happen.
- **CORS error in browser** — make sure you deployed via `supabase functions deploy`, not just placed the file in the directory.

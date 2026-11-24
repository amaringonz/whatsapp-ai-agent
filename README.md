# WhatsApp AI Agent

[![CI](https://github.com/amaringonz/whatsapp-ai-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/amaringonz/whatsapp-ai-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A business-specific AI agent for WhatsApp. It answers customers like a careful team member, qualifies leads, books appointments and **hands the conversation to a human only when the job is done or something needs a person**.

Built with TypeScript, [Hono](https://hono.dev) and the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). It runs on [Claude](https://docs.claude.com) or [OpenAI](https://developers.openai.com), deploys to Vercel and keeps conversations in Upstash Redis.

```
Customer ──▶ WhatsApp ──▶ /webhook ──▶ Agent (LLM + tools) ──▶ WhatsApp reply
                                         │
                                         ├─ get_availability / book_appointment ──▶ your booking API
                                         └─ hand_off ──▶ email to the owner, agent goes quiet
```

## What it does

- **Answers in the customer's language**, in short WhatsApp-style messages, using only what the business wrote in its config. It never invents prices, dates or promises.
- **Works with Claude or OpenAI.** One OpenAI key is enough for everything: conversation, photos, PDFs and voice notes.
- **Reads photos, PDFs and voice notes.** Photos and PDFs go to the model as images and documents; voice notes are transcribed with any OpenAI-compatible speech-to-text API (OpenAI, Groq and others). Attachments are only sent on the turn they arrive, so the saved history stays small. Locations and shared contacts arrive as text; videos and unsupported files get a polite request for another format.
- **Waits for the customer to finish typing.** Several quick messages are answered together, with read receipts and a typing indicator.
- **Books appointments** through a small HTTP contract, so it works with any calendar or backend.
- **Follows up once.** If a customer goes quiet before booking, the agent sends one short, contextual follow-up a few hours later, only during business hours and only inside WhatsApp's 24-hour customer service window.
- **Measures Click-to-WhatsApp ads.** It keeps the ad and click id from the first message, sends them with the booking, and reports the booking to Meta through the [Conversions API for Business Messaging](https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging), so Ads Manager can attribute appointments to ads.
- **Hands off with context.** When the goal is reached or a case is urgent, the owner gets an email with a summary, the lead details and the transcript, and the agent stops answering in that chat.
- **Steps aside when a human writes.** With [WhatsApp Coexistence](https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-business-app-users), messages sent from the WhatsApp Business app pause the agent for that chat. Replying `/bot` from the app hands it back.
- **Stays in scope.** It only talks about the business, which keeps it within WhatsApp's 2026 policy for AI on the Business Platform: business-specific assistants are allowed, general-purpose chatbots are not.
- **Is honest about being an assistant** when someone asks.
- **Protects your AI budget.** Per-contact and daily limits, size caps and blocked numbers keep one person, a bot or a prompt-injection attempt from running up the bill. See [Limits and security](#limits-and-security).
- **Never fails silently.** If the model or WhatsApp fails, the customer gets a short message and the owner gets an email.

## How a conversation flows

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as WhatsApp Cloud API
    participant A as Agent
    participant B as Booking API
    participant O as Owner
    C->>W: "Hi, I sell clothes on Instagram"
    W->>A: webhook (signed)
    A-->>W: 200 OK, then read receipt + typing
    A->>A: wait a few seconds for more messages
    A->>W: reply, one question at a time
    C->>W: picks a time
    A->>B: GET /availability, POST /appointments
    A->>O: hand_off(completed) email with summary
    A->>W: "Done! Gabriel will continue here."
    O-->>C: continues from the WhatsApp Business app
```

## Project layout

```
src/
  routes.ts            Hono routes: webhook verification, signed webhook, health
  index.ts             Vercel entry (uses waitUntil to answer Meta right away)
  server.ts            Local Node server
  agent/
    service.ts         Debounce, locking, pauses, handoff orchestration
    run.ts             Tool-use loop and history trimming
    prompt.ts          System prompt built from the business config
    tools.ts           hand_off, get_availability, book_appointment
    anthropic.ts       Claude adapter (prompt caching on the system prompt)
    openai.ts          OpenAI Responses API adapter
  media/               Photo, PDF and text-file reading; voice note transcription
  whatsapp/            Signature check, webhook parsing, Cloud API client and media download
  store/               Upstash Redis and in-memory conversation stores
  booking/             HTTP booking provider
  notify/              Resend email and console notifiers
  config/              Zod schemas for the environment and the business
examples/              A complete example business
test/                  Vitest suite with a scripted model
```

## Quick start

```bash
npm install
cp .env.example .env            # fill in the values you have
npm test                        # no keys or network needed

# Talk to the agent in your terminal with the example business
OPENAI_API_KEY=... npm run chat -- examples/business.example.json   # or ANTHROPIC_API_KEY
```

In the terminal chat, `/owner <text>` simulates you writing from the WhatsApp Business app and `/bot` hands the chat back to the agent.

## Describe your business

Everything the agent knows comes from one JSON file, validated with Zod. Keep real configs out of git: set `BUSINESS_CONFIG` (the JSON itself) in your hosting provider, or point `BUSINESS_CONFIG_PATH` to a file in the ignored `config/` folder.

```jsonc
{
  "business": { "name": "...", "description": "...", "hours": "...", "language": "es", "timezone": "America/Costa_Rica" },
  "assistant": { "name": "...", "owner": "...", "tone": "...", "disclosure": "..." },
  "goal": "What a successful conversation ends with",
  "knowledge": [{ "title": "Services", "content": "..." }],
  "rules": ["Never give prices", "..."],
  "handoff": {
    "completed": "When the goal counts as done",
    "urgent": ["Situations that need a person right away"]
  },
  "fallbacks": { "error": "...", "busy": "...", "limit": "..." },
  "booking": {
    "enabled": true,
    "description": "...",
    "fields": [{ "name": "budget", "description": "...", "options": [{ "value": "low", "label": "Under $500" }] }]
  }
}
```

See [`examples/business.example.json`](examples/business.example.json) for a full dental clinic.

## Limits and security

| Protection | Default | What happens |
| --- | --- | --- |
| Signed webhooks | always | Requests without a valid `X-Hub-Signature-256` are rejected; payloads over 512 KB get `413` |
| Duplicate and late deliveries | 6 hours | Each message is handled once; messages Meta retries hours later are ignored |
| Messages per contact | 10 per minute, 60 per day | Bursts are dropped. Past the daily limit the chat is paused, the customer gets a short note and the owner an email |
| Message length | 1,500 characters, 4,000 per turn | Longer text is cut before it reaches the model |
| Files per contact | 8 per day | PDFs up to 20 pages, voice notes up to about 5 minutes, photos up to 5 MB |
| Appointments per contact | 2 per week | The booking tool refuses more and suggests a handoff |
| Replies per day, all chats | 1,500 | Past the limit, customers get a "we will answer soon" note and the owner gets one email |
| Blocked numbers | `BLOCKED_NUMBERS` | The agent never answers them. From the WhatsApp Business app, `/block` (or `/bloquear`) blocks a chat and `/unblock` (or `/desbloquear`) lifts it |
| Prompt injection | always | The prompt treats everything a customer sends, including photos and PDFs, as information and never as instructions |
| Failures | always | The customer gets the `fallbacks.error` message; the owner gets at most one email per chat per hour, and one alert per hour if WhatsApp rejects messages (for example, an expired token). OpenAI rate limits and server errors are retried |

Every limit can be changed with an environment variable, and every customer-facing note can be written in your own words under `fallbacks` in the business config.

## Admin routes

With `ADMIN_TOKEN` set, three routes help you support customers and test the agent, all with `Authorization: Bearer <ADMIN_TOKEN>`:

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/admin/chats/:contact` | Shows the saved history and state of a chat (paused, blocked, lead, ad) |
| POST | `/admin/chats/:contact/resume` | Lifts a pause after a handoff, like replying `/bot` from the app |
| POST | `/admin/chats/:contact/reset` | Starts the chat from scratch |

## Booking API contract

Booking is optional. When `BOOKING_API_URL` and `BOOKING_API_TOKEN` are set, the agent calls two endpoints with `Authorization: Bearer <token>`:

| Method | Path            | Response                                                                 |
| ------ | --------------- | ------------------------------------------------------------------------ |
| GET    | `/availability` | `{ "days": [{ "date": "2026-12-02", "label": "Wed Dec 2", "slots": [{ "time": "09:00", "label": "9:00 a.m." }] }] }` |
| POST   | `/appointments` | `201 { "id", "summary" }`, `409` if the slot was taken, `422` if data is invalid |

The POST body is `{ name, phone, date, time, fields, source: "whatsapp", origin? }`, where `fields` holds the booking fields from your config and `origin` is `{ source: "facebook", medium: "whatsapp-ad", campaign, content, clickId }` when the chat started from an ad (`content` is the ad id and `clickId` the `ctwa_clid`).

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | yes | Cloud API access |
| `WHATSAPP_APP_SECRET` | yes | Verifies `X-Hub-Signature-256` on every webhook |
| `WHATSAPP_VERIFY_TOKEN` | yes | Any string; repeat it when you register the webhook |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | yes | The model provider. With only an OpenAI key, OpenAI also transcribes voice notes |
| `AI_PROVIDER` | no | `openai` or `anthropic`. Defaults to Anthropic when its key is set, otherwise OpenAI |
| `OPENAI_MODEL`, `OPENAI_BASE_URL` | no | Defaults to `gpt-6.2-sol` on `https://api.openai.com/v1` |
| `OPENAI_REASONING_EFFORT` | no | Defaults to `low`. Leave it empty for models without reasoning |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-5-5` |
| `BUSINESS_CONFIG` or `BUSINESS_CONFIG_PATH` | yes | The business description |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` (or `KV_REST_API_*`) | production | Conversation memory; falls back to memory |
| `BOOKING_API_URL`, `BOOKING_API_TOKEN` | no | Enables booking tools |
| `TRANSCRIPTION_API_KEY` | no | Enables voice notes. Uses `OPENAI_API_KEY` when transcribing with OpenAI. Without a key the agent asks the customer to write instead |
| `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL` | no | Any OpenAI-compatible `/audio/transcriptions` API. Defaults to OpenAI `gpt-4o-mini-transcribe`; for Groq use `https://api.groq.com/openai/v1` and `whisper-large-v3-turbo` |
| `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM`, `NOTIFY_EMAIL_TO` | no | Handoff emails; falls back to logs |
| `ADMIN_TOKEN` | no | Enables the [admin routes](#admin-routes) |
| `CRON_SECRET` | no | Enables follow-ups. Vercel Cron calls `/cron/follow-ups` every 15 minutes with it (see `vercel.json`) |
| `FOLLOW_UP_HOURS`, `FOLLOW_UP_START_HOUR`, `FOLLOW_UP_END_HOUR` | no | Defaults `4`, `8` and `20`, in the business time zone. `0` hours turns follow-ups off |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | no | Enables ad conversion events for chats that came from Click-to-WhatsApp ads |
| `META_DATASET_ID`, `META_EVENTS_TOKEN` | no | The dataset is looked up from the WhatsApp account when empty; the token defaults to `WHATSAPP_TOKEN` and needs `whatsapp_business_manage_events` |
| `BLOCKED_NUMBERS` | no | Comma-separated numbers the agent never answers |
| `LIMIT_MESSAGES_PER_MINUTE`, `LIMIT_MESSAGES_PER_DAY` | no | Per contact, defaults `10` and `60` |
| `LIMIT_MEDIA_PER_DAY`, `LIMIT_BOOKINGS_PER_WEEK` | no | Per contact, defaults `8` and `2` |
| `LIMIT_REPLIES_PER_DAY` | no | All chats together, default `1500` |
| `MAX_MESSAGE_CHARS`, `MAX_TURN_CHARS` | no | Defaults `1500` and `4000` |
| `MAX_MESSAGE_AGE_MINUTES`, `MAX_PDF_PAGES`, `MAX_AUDIO_SECONDS` | no | Defaults `360`, `20` and `300` |
| `DEBOUNCE_MS` | no | Wait for more messages, default `4000` |
| `HUMAN_PAUSE_HOURS` | no | How long the agent stays quiet after a handoff or a human reply, default `24` |
| `HISTORY_LIMIT` | no | Messages kept per chat, default `40` |

## Deploy

1. Import the repository in Vercel. It detects Hono and serves `src/index.ts`.
2. Add an Upstash Redis store from Vercel Storage and the variables above.
3. Set `CRON_SECRET` to turn on follow-ups; `vercel.json` already schedules the cron.
4. In your Meta app, set the callback URL to `https://<your-app>/webhook` with your verify token and subscribe to `messages` and `smb_message_echoes`.
5. To keep using the WhatsApp Business app on the same number, onboard it with **Coexistence**. Meta asks for some days of real activity in the app before the number qualifies.

## Testing

`npm test` runs the suite with a scripted model, so it needs no keys or network. It covers signature checks, webhook parsing, media reading and transcription, both model adapters, rate limits, blocking, budget and failure handling, follow-ups, ad attribution, prompt building, history trimming, debouncing, booking, handoff, human takeover, pause expiry and tool failures. `npm run typecheck` runs the TypeScript compiler in strict mode.

## License

[MIT](LICENSE) © 2026 Alejandro Marín González

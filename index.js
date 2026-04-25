require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DB migration on startup ───────────────────────────────────────────────────

async function runMigration() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'migrations', '001_create_activities.sql'),
    'utf8'
  );
  const { error } = await supabase.rpc('exec_sql', { sql }).maybeSingle();
  // exec_sql RPC may not exist; fall back to a raw query via the REST API
  if (error) {
    // The Supabase JS client doesn't expose raw DDL directly.
    // We use the management REST endpoint instead — if SUPABASE_SERVICE_KEY is
    // the service_role JWT the table will already exist from the migration file;
    // skip and continue.
    console.log('[migration] skipped (table may already exist or exec_sql RPC unavailable)');
  } else {
    console.log('[migration] activities table ready');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function metersToMiles(m) {
  return (m / 1609.344).toFixed(2);
}

function secondsToPace(distanceM, movingTimeS) {
  if (!distanceM || distanceM === 0) return 'N/A';
  const mileSeconds = movingTimeS / (distanceM / 1609.344);
  const mins = Math.floor(mileSeconds / 60);
  const secs = Math.round(mileSeconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}/mi`;
}

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[telegram] send failed:', res.status, body.slice(0, 200));
  }
}

// ── Coaching ──────────────────────────────────────────────────────────────────

async function getCoachingResponse(userText) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: activities, error } = await supabase
    .from('activities')
    .select('type, distance_m, moving_time_s, started_at')
    .gte('started_at', since)
    .order('started_at', { ascending: false });

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  let activitySummary = 'No activities in the last 14 days.';
  if (activities && activities.length > 0) {
    activitySummary = activities
      .map((a) => {
        const date = new Date(a.started_at).toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
        });
        const miles = metersToMiles(a.distance_m);
        const duration = formatDuration(a.moving_time_s);
        const pace = a.type === 'Run'
          ? ` | ${secondsToPace(a.distance_m, a.moving_time_s)}`
          : '';
        return `${date}: ${a.type} — ${miles} mi | ${duration}${pace}`;
      })
      .join('\n');
  }

  const systemPrompt =
    'You are an expert endurance coach. Give concrete, personalized advice based ' +
    "on the athlete's recent training. Be direct and specific. Use imperial units.";

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Recent training (last 14 days):\n${activitySummary}\n\nAthlete: ${userText}`,
      },
    ],
  });

  return message.content[0].text;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Strava webhook via Composio
app.post(
  `/webhook/strava/${process.env.COMPOSIO_WEBHOOK_SECRET}`,
  async (req, res) => {
    res.sendStatus(200); // ack immediately

    try {
      const payload = req.body;
      // Composio wraps the event; drill into the actual Strava activity data
      const activity =
        payload?.data?.activity ||
        payload?.activity ||
        payload;

      const stravaId =
        activity?.id ||
        activity?.object_id ||
        payload?.object_id;

      if (!stravaId) {
        console.warn('[strava] no strava_id found in payload keys:', Object.keys(payload));
        return;
      }

      const { error } = await supabase.from('activities').upsert(
        {
          strava_id: Number(stravaId),
          type: activity.type || activity.sport_type || null,
          distance_m: activity.distance || null,
          moving_time_s: activity.moving_time || null,
          started_at: activity.start_date || null,
          raw: payload,
        },
        { onConflict: 'strava_id' }
      );

      if (error) {
        console.error('[strava] upsert error:', error.message);
      } else {
        console.log('[strava] upserted activity', stravaId);
      }
    } catch (err) {
      console.error('[strava] handler error:', err.message);
    }
  }
);

// Telegram webhook
app.post('/webhook/telegram', async (req, res) => {
  // Verify secret token
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // always ack before doing async work

  try {
    const update = req.body;
    const message = update?.message || update?.edited_message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = message.text;
    if (!text) return;

    const reply = await getCoachingResponse(text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
  }
});

app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/ping', (_req, res) => res.status(200).send('pong'));

// ── Keep-alive ────────────────────────────────────────────────────────────────

function startKeepAlive() {
  const PORT = process.env.PORT || 3000;
  setInterval(async () => {
    try {
      await fetch(`http://localhost:${PORT}/health`);
    } catch (_) {
      // ignore — server may be momentarily busy
    }
  }, 10 * 60 * 1000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

runMigration()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on port ${PORT}`);
      startKeepAlive();
    });
  })
  .catch((err) => {
    console.error('[boot] migration error (continuing anyway):', err.message);
    app.listen(PORT, () => {
      console.log(`[server] listening on port ${PORT}`);
      startKeepAlive();
    });
  });

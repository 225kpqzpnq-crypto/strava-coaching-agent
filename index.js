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
  // Supabase exposes a raw SQL endpoint for service-role keys at /rest/v1/sql
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'apikey': process.env.SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const body = await res.text();
    // If it's just a "already exists" error that's fine
    if (body.includes('already exists')) {
      console.log('[migration] activities table already exists');
    } else {
      console.warn('[migration] SQL endpoint returned', res.status, body.slice(0, 200));
      console.warn('[migration] Run migrations/001_create_activities.sql manually in your Supabase SQL editor if the table does not exist');
    }
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

const KNOWN_FILES = [
  'Training_log_Apr_2026.md',
  'Training_log_Mar_2026.md',
  'Training_plan_April_2026.md',
  'training_plan_march.md',
  'season_overview_to_june.md',
  'water_sessions_log.md',
  'runs_log.md',
  'back_injury_log.md',
  'squad_benchmarks.md',
  'Races.md',
  'Technique_feedback.md',
  'Rowing MOC.md',
  'context_prompt.md',
  'SCCBC_Easter_Holiday_Training_2026.md',
];

async function logDebrief(rawText) {
  // Ask Claude to pick the right file and format the entry
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const formatMsg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a rowing training log assistant. Format debrief notes as clean markdown entries and pick the most appropriate file to append to.',
    messages: [{
      role: 'user',
      content: `Today is ${today}.

The athlete sent this debrief:\n"${rawText}"

Available files:\n${KNOWN_FILES.join('\n')}

Reply with ONLY valid JSON in this exact shape:
{
  "filename": "<one filename from the list above>",
  "entry": "<formatted markdown entry starting with a ## heading including the date>"
}`,
    }],
  });

  let filename, entry;
  try {
    const raw = formatMsg.content[0].text.replace(/```json|```/g, '').trim();
    ({ filename, entry } = JSON.parse(raw));
    if (!KNOWN_FILES.includes(filename)) throw new Error('unknown file');
  } catch (e) {
    console.error('[debrief] parse error:', e.message, formatMsg.content[0].text.slice(0, 200));
    return 'Sorry, I could not format that debrief. Try again.';
  }

  // Fetch current content
  const { data: row, error: fetchErr } = await supabase
    .from('rowing_notes')
    .select('content')
    .eq('filename', filename)
    .single();

  if (fetchErr) return `Could not read ${filename}: ${fetchErr.message}`;

  const updatedContent = (row.content || '') + '\n\n' + entry;
  const now = new Date().toISOString();

  const { error: upsertErr } = await supabase
    .from('rowing_notes')
    .upsert({ filename, content: updatedContent, last_synced: now, server_updated_at: now }, { onConflict: 'filename' });

  if (upsertErr) return `Failed to save debrief: ${upsertErr.message}`;

  console.log(`[debrief] appended to ${filename}`);
  return `✅ Logged to *${filename}*\n\n${entry}`;
}

async function getCoachingResponse(userText) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: activities, error: actErr }, { data: notes, error: notesErr }] = await Promise.all([
    supabase
      .from('activities')
      .select('type, distance_m, moving_time_s, started_at')
      .gte('started_at', since)
      .order('started_at', { ascending: false }),
    supabase
      .from('rowing_notes')
      .select('filename, content'),
  ]);

  if (actErr) throw new Error(`Activities query failed: ${actErr.message}`);
  if (notesErr) throw new Error(`Notes query failed: ${notesErr.message}`);

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

  let notesSummary = '';
  if (notes && notes.length > 0) {
    notesSummary = notes
      .map((n) => `=== ${n.filename} ===\n${n.content}`)
      .join('\n\n');
  }

  const systemPrompt =
    'You are an expert endurance coach with full access to the athlete\'s training notes, ' +
    'plans, logs, and recent Strava activity data. Give concrete, personalized advice. ' +
    'Be direct and specific. Use the notes and activity data together to give accurate answers.';

  const userContent = [
    `## Recent Strava activity (last 14 days)\n${activitySummary}`,
    notesSummary ? `## Athlete training notes & plans\n${notesSummary}` : '',
    `## Athlete question\n${userText}`,
  ].filter(Boolean).join('\n\n');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  return message.content[0].text;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Strava webhook — GET for subscription verification challenge
app.get('/webhook/strava', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
    console.log('[strava] webhook verified');
    return res.json({ 'hub.challenge': challenge });
  }
  res.sendStatus(403);
});

// Strava webhook — POST for activity events
app.post('/webhook/strava', async (req, res) => {
  res.sendStatus(200); // ack immediately — Strava expects fast response

  try {
    const event = req.body;
    // Only process activity create/update events
    if (event.object_type !== 'activity') return;
    if (!['create', 'update'].includes(event.aspect_type)) return;

    const stravaId = event.object_id;
    if (!stravaId) return;

    // Fetch full activity details from Strava using the athlete's access token
    const { data: tokenRow } = await supabase
      .from('strava_tokens')
      .select('access_token')
      .eq('athlete_id', event.owner_id)
      .single();

    let activity = { id: stravaId, type: null, distance: null, moving_time: null, start_date: null };

    if (tokenRow?.access_token) {
      const actRes = await fetch(`https://www.strava.com/api/v3/activities/${stravaId}`, {
        headers: { Authorization: `Bearer ${tokenRow.access_token}` },
      });
      if (actRes.ok) {
        activity = await actRes.json();
      } else {
        console.warn('[strava] could not fetch activity detail, storing event stub');
      }
    }

    const { error } = await supabase.from('activities').upsert(
      {
        strava_id: Number(stravaId),
        type: activity.type || activity.sport_type || null,
        distance_m: activity.distance || null,
        moving_time_s: activity.moving_time || null,
        started_at: activity.start_date || null,
        raw: event,
      },
      { onConflict: 'strava_id' }
    );

    if (error) {
      console.error('[strava] upsert error:', error.message);
    } else {
      console.log('[strava] upserted activity', stravaId, activity.type || '');
    }
  } catch (err) {
    console.error('[strava] handler error:', err.message);
  }
});

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

    const reply = text.trimStart().startsWith('/log ')
      ? await logDebrief(text.slice(text.indexOf(' ') + 1).trim())
      : await getCoachingResponse(text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
  }
});

// Strava OAuth — start the auth flow
app.get('/strava/connect', (_req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: `https://strava-coaching-agent.onrender.com/strava/callback`,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read_all',
  });
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

// Strava OAuth — exchange code for tokens and store them
app.get('/strava/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.status(400).send(`Strava auth failed: ${error || 'no code'}`);

  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return res.status(500).send(`Token exchange failed: ${body.slice(0, 200)}`);
  }

  const token = await tokenRes.json();
  const { error: dbErr } = await supabase.from('strava_tokens').upsert({
    athlete_id: token.athlete.id,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: token.expires_at,
  });

  if (dbErr) return res.status(500).send(`DB error: ${dbErr.message}`);
  res.send(`✅ Connected Strava account for ${token.athlete.firstname} ${token.athlete.lastname}. You can close this tab.`);
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

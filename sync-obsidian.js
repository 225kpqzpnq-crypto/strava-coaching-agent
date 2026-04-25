require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BASE = '/Users/jamesmoffat/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian/Projects/Rowing';

const FILES = [
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
  'quick_debrief.md',
];

async function ensureTable() {
  const { error } = await supabase.from('rowing_notes').select('filename').limit(1);
  if (error && error.code === 'PGRST205') {
    console.error('[sync] rowing_notes table not found — run migrations/003_create_rowing_notes.sql in the Supabase SQL editor');
    process.exit(1);
  }
}

async function main() {
  await ensureTable();

  // Fetch all rows from Supabase in one query
  const { data: rows, error } = await supabase
    .from('rowing_notes')
    .select('filename, content, last_synced, server_updated_at');

  if (error) {
    console.error('[sync] fetch error:', error.message);
    process.exit(1);
  }

  const supabaseMap = Object.fromEntries((rows || []).map(r => [r.filename, r]));

  let synced = 0;
  let pulled = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  const upserts = [];

  for (const filename of FILES) {
    const filepath = path.join(BASE, filename);
    const row = supabaseMap[filename];

    // If server wrote a debrief more recently than the last local→Supabase push, pull it down first
    if (row?.server_updated_at && row?.last_synced) {
      const serverUpdated = new Date(row.server_updated_at);
      const lastSynced = new Date(row.last_synced);

      if (serverUpdated > lastSynced) {
        fs.writeFileSync(filepath, row.content ?? '', 'utf8');
        console.log(`[sync] pulled ${filename} (server debrief added)`);
        pulled++;
        // Now push back to mark last_synced, clearing the server_updated_at priority
        upserts.push({ filename, content: row.content, last_synced: now, server_updated_at: row.server_updated_at });
        continue;
      }
    }

    // Normal push: local → Supabase
    if (!fs.existsSync(filepath)) {
      skipped++;
      continue;
    }

    const content = fs.readFileSync(filepath, 'utf8');
    upserts.push({ filename, content, last_synced: now });
    synced++;
  }

  if (upserts.length > 0) {
    const { error: upsertErr } = await supabase
      .from('rowing_notes')
      .upsert(upserts, { onConflict: 'filename' });

    if (upsertErr) {
      console.error('[sync] upsert error:', upsertErr.message);
      process.exit(1);
    }
  }

  const parts = [`Synced ${synced} files`];
  if (pulled > 0) parts.push(`pulled ${pulled} from server`);
  if (skipped > 0) parts.push(`skipped ${skipped}`);
  console.log(parts.join(', '));
}

main().catch(err => {
  console.error('[sync] fatal:', err.message);
  process.exit(1);
});

CREATE TABLE IF NOT EXISTS strava_tokens (
  athlete_id    bigint PRIMARY KEY,
  access_token  text NOT NULL,
  refresh_token text NOT NULL,
  expires_at    bigint NOT NULL,
  updated_at    timestamptz DEFAULT now()
);

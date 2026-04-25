CREATE TABLE IF NOT EXISTS activities (
  id          bigserial PRIMARY KEY,
  strava_id   bigint UNIQUE NOT NULL,
  type        text,
  distance_m  float,
  moving_time_s int,
  started_at  timestamptz,
  raw         jsonb,
  created_at  timestamptz DEFAULT now()
);

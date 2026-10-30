-- Read-only mirror of the always-on computer's database, for following it on a hosted page.
-- Run once in the Supabase SQL editor. The server fills these tables every minute (server/mirror.cjs).
-- Row level security is on with no policies: only the service role key can read or write.

create table if not exists queue1 (
  item_id text primary key,
  position integer,
  kind text,
  subreddit text,
  title text,
  url text,
  score integer,
  added_at timestamptz,
  claimed_at timestamptz
);

create table if not exists queue2 (
  id bigint primary key,
  item_id text,
  kind text,
  subreddit text,
  title text,
  url text,
  thread_url text,
  message text,
  write_status text,
  model text,
  provider text,
  prompt_variant_slug text,
  send_status text,
  delivery_mode text,
  approved_by text,
  approved_at timestamptz,
  engain_task_id text,
  engain_status text,
  reddit_url text,
  send_error text,
  created_at timestamptz,
  written_at timestamptz,
  sent_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz
);

create table if not exists events (
  id bigint primary key,
  at timestamptz not null,
  type text not null,
  message text,
  item_id text,
  queue2_id bigint,
  data jsonb
);
create index if not exists events_at on events (at desc);

-- API keys of the always-on computer (sha256 hashes only), checked by the hosted page.
create table if not exists api_keys (
  id text primary key, name text not null, scope text not null, prefix text not null, hash text not null unique,
  created_at timestamptz, revoked_at timestamptz);

-- One row: jobs, settings and counts, as of synced_at.
create table if not exists status (
  id text primary key,
  synced_at timestamptz,
  data jsonb
);

-- Commands from the hosted page (settings, run a job now, fast mode); the computer polls them.
create table if not exists commands (
  id bigint generated always as identity primary key, at timestamptz not null default now(), by text, kind text not null,
  payload jsonb, status text not null default 'pending', result jsonb, done_at timestamptz);
create index if not exists commands_pending on commands (id) where status = 'pending';

alter table queue1 enable row level security;
alter table queue2 enable row level security;
alter table events enable row level security;
alter table status enable row level security;
alter table api_keys enable row level security;
alter table commands enable row level security;

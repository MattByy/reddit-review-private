-- Organizations: each one is a separate engine on the always-on computer (its own Engain key, queues,
-- prompts and settings). Every mirrored row carries its organization; existing rows are Geonode's.
-- Safe to run more than once, and compatible with a server that does not know about organizations
-- yet (its rows get org = 'geonode' by default).

alter table queue1 add column if not exists org text not null default 'geonode';
alter table queue2 add column if not exists org text not null default 'geonode';
alter table events add column if not exists org text not null default 'geonode';
alter table api_keys add column if not exists org text not null default 'geonode';
alter table snapshots add column if not exists org text not null default 'geonode';
alter table status add column if not exists org text not null default 'geonode';
alter table commands add column if not exists org text not null default 'geonode';

-- Keys include the organization (two organizations have their own Queue 2 #1, event #1, ...).
do $$ begin
  if (select count(*) from information_schema.key_column_usage where constraint_name='queue1_pkey')=1 then
    alter table queue1 drop constraint queue1_pkey; alter table queue1 add primary key (org,item_id); end if;
  if (select count(*) from information_schema.key_column_usage where constraint_name='queue2_pkey')=1 then
    alter table queue2 drop constraint queue2_pkey; alter table queue2 add primary key (org,id); end if;
  if (select count(*) from information_schema.key_column_usage where constraint_name='events_pkey')=1 then
    alter table events drop constraint events_pkey; alter table events add primary key (org,id); end if;
  if (select count(*) from information_schema.key_column_usage where constraint_name='api_keys_pkey')=1 then
    alter table api_keys drop constraint api_keys_pkey; alter table api_keys add primary key (org,id); end if;
  if (select count(*) from information_schema.key_column_usage where constraint_name='snapshots_pkey')=1 then
    alter table snapshots drop constraint snapshots_pkey; alter table snapshots add primary key (org,key); end if;
end $$;
create index if not exists events_org_at on events (org, at desc);
create index if not exists commands_org_pending on commands (org, id) where status = 'pending';

-- The organizations the computer runs (written by the computer; the Engain key never leaves it).
create table if not exists organizations (
  slug text primary key, name text not null, about text, brand_terms text, topic_terms text, ready boolean not null default true,
  created_at timestamptz not null default now(), created_by text);
insert into organizations (slug, name, about) values ('geonode', 'Geonode', 'proxies and web-scraping infrastructure')
  on conflict (slug) do nothing;

-- Owners see every organization, add organizations and update or restart the server.
alter table monitor_users add column if not exists is_owner boolean not null default false;
update monitor_users set is_owner = true where username = 'matas';

-- Who may use which organization: admin (everything in it), editor (drafts, sending, prompts), viewer (read only).
create table if not exists org_members (
  org text not null references organizations(slug) on delete cascade,
  username text not null references monitor_users(username) on delete cascade,
  role text not null check (role in ('admin','editor','viewer')),
  added_at timestamptz not null default now(), added_by text,
  primary key (org, username));

-- Invite links: the token is shown once to whoever made it; only its sha256 is kept.
create table if not exists invites (
  token_hash text primary key,
  org text not null references organizations(slug) on delete cascade,
  role text not null check (role in ('admin','editor','viewer')),
  created_by text, created_at timestamptz not null default now(), expires_at timestamptz not null,
  used_at timestamptz, used_by text, revoked_at timestamptz);

alter table organizations enable row level security;
alter table org_members enable row level security;
alter table invites enable row level security;

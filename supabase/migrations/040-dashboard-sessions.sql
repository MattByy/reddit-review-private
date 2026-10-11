begin;

-- Browser credentials and sessions are accessible only to the server.
create table dashboard_admin (
  singleton boolean primary key default true check (singleton),
  password_hash text,
  setup_token_hash text,
  setup_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into dashboard_admin(singleton) values(true);
create table dashboard_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index dashboard_sessions_expiry on dashboard_sessions(expires_at);
create table dashboard_login_limits (
  bucket text primary key,
  window_start timestamptz not null default now(),
  attempts integer not null default 1
);
alter table dashboard_admin enable row level security;
alter table dashboard_sessions enable row level security;
alter table dashboard_login_limits enable row level security;
revoke all on dashboard_admin,dashboard_sessions,dashboard_login_limits from public,anon,authenticated;
grant select,insert,update,delete on dashboard_admin,dashboard_sessions,dashboard_login_limits to service_role;

create function consume_dashboard_login(p_bucket text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare tries integer;
begin
  delete from dashboard_login_limits where window_start < now()-interval '1 day';
  insert into dashboard_login_limits(bucket) values(p_bucket)
  on conflict(bucket) do update set
    attempts=case when dashboard_login_limits.window_start <= now()-interval '15 minutes' then 1 else dashboard_login_limits.attempts+1 end,
    window_start=case when dashboard_login_limits.window_start <= now()-interval '15 minutes' then now() else dashboard_login_limits.window_start end
  returning attempts into tries;
  return tries<=10;
end $$;

create function setup_dashboard_admin(p_setup_hash text,p_password_hash text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_password_hash is null or p_password_hash not like 'scrypt:%' then return false; end if;
  update dashboard_admin set password_hash=p_password_hash,setup_token_hash=null,setup_expires_at=null,updated_at=now()
  where singleton and password_hash is null and setup_token_hash=p_setup_hash and setup_expires_at>now();
  return found;
end $$;
revoke all on function consume_dashboard_login(text),setup_dashboard_admin(text,text) from public,anon,authenticated;
grant execute on function consume_dashboard_login(text),setup_dashboard_admin(text,text) to service_role;
commit;

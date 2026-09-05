-- Study With Cats: online party schema. Idempotent; applied at boot by server/store-pg.mjs.
-- Mirrors docs/superpowers/specs/2026-09-05-online-party-design.md section 5 exactly.
create table if not exists players (
  id           bigserial primary key,
  key_hash     bytea not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table if not exists parties (
  id             bigserial primary key,
  code           text not null check (code ~ '^[A-Z2-9]{6}$'),
  room           text not null check (char_length(room) between 1 and 24),
  host_id        bigint not null references players(id),
  shared_minutes integer not null default 0 check (shared_minutes >= 0),
  cheers         integer not null default 0 check (cheers >= 0),
  timer          jsonb,
  created_at     timestamptz not null default now(),
  closed_at      timestamptz
);
create unique index if not exists parties_open_code on parties (code) where closed_at is null;
create table if not exists party_members (
  party_id  bigint not null references parties(id),
  player_id bigint not null references players(id),
  seat      smallint not null check (seat between 0 and 7),
  name      text not null check (char_length(name) between 1 and 14),
  cat       jsonb not null,
  joined_at timestamptz not null default now(),
  left_at   timestamptz,
  primary key (party_id, player_id)
);
create unique index if not exists party_members_seat      on party_members (party_id, seat) where left_at is null;
create unique index if not exists party_members_one_party on party_members (player_id)      where left_at is null;

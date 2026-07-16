-- ALWA v2 — Supabase şeması
-- KURULUM: Supabase projenizde SQL Editor'ü açın, bu dosyanın TAMAMINI
-- yapıştırın ve Run'a basın. Tekrar çalıştırmak güvenlidir (IF NOT EXISTS).
--
-- Tablolar:
--   students          kayıtlı öğrenci/veli/müşteri listesi (kimlik katmanı).
--                     Mevcut listenizi Table Editor > students > Insert >
--                     Import data from CSV ile yükleyin. phone kolonu
--                     uluslararası formatta, sadece rakam: 905551112233
--   conversations     her mesaj bir satır (Sheets 'messages' sekmesinin DB hali)
--   leads             kayıt/aranma isteyen potansiyel müşteriler
--   complaints        deadline'lı şikayet kayıtları ("panel" = bu tablonun
--                     Supabase Table Editor görünümü)
--   survey_responses  anket buton cevapları

create table if not exists students (
  phone      text primary key,
  name       text,
  branch     text,
  notes      text,
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  session_id  text not null,
  direction   text not null check (direction in ('incoming', 'outgoing')),
  sender      text not null,
  text        text,
  intent      text,
  needs_human boolean not null default false,
  status      text
);
create index if not exists conversations_session_ts on conversations (session_id, ts desc);
create index if not exists conversations_ts on conversations (ts);

create table if not exists leads (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  phone        text not null,
  name         text,
  topic        text,
  last_message text,
  status       text not null default 'new'  -- new / contacted / won / lost
);

create table if not exists complaints (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  phone         text not null,
  summary       text,
  branch        text,
  deadline      timestamptz not null,
  status        text not null default 'open',  -- open / resolved
  reminder_sent boolean not null default false,
  resolved_at   timestamptz
);
create index if not exists complaints_open on complaints (status, deadline);

create table if not exists survey_responses (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  phone     text not null,
  survey_id text,
  answer    text
);

-- Bu tablolara yalnızca sunucu (service_role anahtarı) erişir; RLS'i açık
-- tutup anon erişimini tamamen kapatıyoruz.
alter table students         enable row level security;
alter table conversations    enable row level security;
alter table leads            enable row level security;
alter table complaints       enable row level security;
alter table survey_responses enable row level security;

-- Rolê de Slides — backend no Supabase.
--
-- Mesmo modelo do moodboard (cluster): o front usa só a chave pública (anon).
-- As tabelas ficam no schema privado "rs" (fora da API REST) com RLS ligado e
-- sem políticas; tudo passa por funções RPC em "public" (security definer).
-- Erros voltam como {"error": "..."} em vez de exceção, para que tentativas
-- erradas de PIN não sejam desfeitas pelo rollback e o limite funcione.
--
-- Rode inteiro no SQL Editor do projeto (é idempotente). Depois defina o PIN
-- do organizador (4 a 8 dígitos):
--   insert into rs.config values ('organizer_pin', '1234')
--   on conflict (key) do update set value = excluded.value;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists rs;

create table if not exists rs.blocks (
  id text primary key,
  capacity int not null check (capacity between 0 and 50),
  position int not null
);

insert into rs.blocks (id, capacity, position) values
  ('block_1', 5, 1),
  ('block_2', 5, 2),
  ('block_3', 6, 3)
on conflict (id) do update set capacity = excluded.capacity, position = excluded.position;

create table if not exists rs.registrations (
  id text primary key,
  block_id text not null references rs.blocks (id),
  name text not null check (char_length(name) between 1 and 40),
  topic_mode text not null check (topic_mode in ('defined', 'secret', 'tbd')),
  topic_title text not null default '' check (char_length(topic_title) <= 300),
  tech text[] not null default '{}',
  order_index int not null,
  created_at bigint not null,
  owner_hash text not null
);
create index if not exists registrations_block on rs.registrations (block_id, order_index, created_at);

create table if not exists rs.config (
  key text primary key,
  value text not null
);

create table if not exists rs.fails (
  key text primary key,
  n int not null,
  until timestamptz not null
);

alter table rs.blocks enable row level security;
alter table rs.registrations enable row level security;
alter table rs.config enable row level security;
alter table rs.fails enable row level security;

revoke all on all tables in schema rs from public, anon, authenticated;
revoke all on schema rs from public, anon, authenticated;

-- ---------------------------------------------------------------- utilitários

create or replace function rs.now_ms() returns bigint
language sql volatile set search_path = '' as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;

create or replace function rs.new_id(len int default 12) returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '0123456789abcdefghijkmnopqrstuvwxyz';
  b bytea := extensions.gen_random_bytes(len);
  out text := '';
begin
  for i in 0 .. len - 1 loop
    out := out || substr(alphabet, get_byte(b, i) % 35 + 1, 1);
  end loop;
  return out;
end $$;

create or replace function rs.sha256(v text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(v, 'sha256'), 'hex')
$$;

create or replace function rs.err(code text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('error', code)
$$;

create or replace function rs.client_key() returns text
language sql stable set search_path = '' as $$
  select coalesce(
    nullif(trim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)), ''),
    '?'
  ) || '|pin'
$$;

create or replace function rs.blocked(k text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from rs.fails where key = k and until > now() and n >= 8)
$$;

create or replace function rs.fail(k text) returns void
language sql volatile set search_path = '' as $$
  insert into rs.fails (key, n, until) values (k, 1, now() + interval '10 minutes')
  on conflict (key) do update set
    n = case when rs.fails.until > now() then rs.fails.n + 1 else 1 end,
    until = case when rs.fails.until > now() then rs.fails.until else excluded.until end
$$;

-- confere o PIN do organizador; devolve null se ok, ou o código do erro
create or replace function rs.check_pin(pin text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  k text := rs.client_key();
  expected text;
begin
  if rs.blocked(k) then return 'throttled'; end if;
  select value into expected from rs.config where key = 'organizer_pin';
  if expected is null then return 'no_pin'; end if;
  if pin is null or pin !~ '^\d{4,8}$' or pin <> expected then
    perform rs.fail(k);
    return 'bad_pin';
  end if;
  return null;
end $$;

-- avisa quem está com a página aberta (Realtime Broadcast, canal público "role-slides")
create or replace function rs.notify(kind text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('kind', kind), 'change', 'role-slides', false);
exception when others then
  null; -- tempo real é bônus: nunca derruba a operação
end $$;

-- renumera a ordem de um bloco para 0..n-1
create or replace function rs.renumber(block text) returns void
language sql volatile set search_path = '' as $$
  update rs.registrations r set order_index = s.rn - 1
  from (
    select id, row_number() over (order by order_index, created_at) as rn
    from rs.registrations where block_id = block
  ) s
  where r.id = s.id and r.order_index <> s.rn - 1
$$;

create or replace function rs.state() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'capacity', b.capacity) order by b.position)
      from rs.blocks b
    ), '[]'::jsonb),
    'registrations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'blockId', r.block_id,
        'name', r.name,
        'topicMode', r.topic_mode,
        'topicTitle', r.topic_title,
        'tech', to_jsonb(r.tech),
        'orderIndex', r.order_index,
        'createdAt', r.created_at
      ) order by b.position, r.order_index, r.created_at)
      from rs.registrations r join rs.blocks b on b.id = r.block_id
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- API pública

create or replace function public.rs_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select rs.state()
$$;

create or replace function public.rs_register(
  p_name text, p_block text, p_topic_mode text, p_topic_title text, p_tech text[], p_key text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  cap int;
  taken int;
  next_order int;
  new_id text;
  clean_name text := trim(coalesce(p_name, ''));
  clean_title text := trim(coalesce(p_topic_title, ''));
  clean_tech text[];
begin
  if char_length(clean_name) < 1 or char_length(clean_name) > 40 then return rs.err('bad_name'); end if;
  if p_topic_mode is null or p_topic_mode not in ('defined', 'secret', 'tbd') then return rs.err('bad_topic'); end if;
  if p_topic_mode = 'defined' then
    if char_length(clean_title) < 1 or char_length(clean_title) > 300 then return rs.err('bad_topic'); end if;
  else
    clean_title := '';
  end if;
  if p_key is null or char_length(p_key) < 16 or char_length(p_key) > 128 then return rs.err('bad_key'); end if;

  select coalesce(array_agg(distinct t), '{}') into clean_tech
  from unnest(coalesce(p_tech, '{}')) t
  where t in ('own_laptop', 'send_file', 'audio_out');

  -- trava o bloco: duas pessoas não pegam a última vaga ao mesmo tempo
  select capacity into cap from rs.blocks where id = p_block for update;
  if cap is null then return rs.err('bad_block'); end if;

  select count(*), coalesce(max(order_index), -1) + 1 into taken, next_order
  from rs.registrations where block_id = p_block;
  if taken >= cap then return rs.err('full'); end if;

  new_id := rs.new_id();
  insert into rs.registrations (id, block_id, name, topic_mode, topic_title, tech, order_index, created_at, owner_hash)
  values (new_id, p_block, clean_name, p_topic_mode, clean_title, clean_tech, next_order, rs.now_ms(), rs.sha256(p_key));

  perform rs.notify('register');
  return jsonb_build_object('id', new_id);
end $$;

-- quem se inscreveu pode cancelar a própria inscrição (chave guardada no navegador)
create or replace function public.rs_cancel(p_id text, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  blk text;
begin
  if p_key is null or char_length(p_key) < 16 then return rs.err('forbidden'); end if;
  delete from rs.registrations where id = p_id and owner_hash = rs.sha256(p_key) returning block_id into blk;
  if blk is null then return rs.err('forbidden'); end if;
  perform rs.renumber(blk);
  perform rs.notify('cancel');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rs_check_pin(p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := rs.check_pin(p_pin);
begin
  if e is not null then return rs.err(e); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rs_remove(p_pin text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := rs.check_pin(p_pin);
  blk text;
begin
  if e is not null then return rs.err(e); end if;
  delete from rs.registrations where id = p_id returning block_id into blk;
  if blk is null then return rs.err('not_found'); end if;
  perform rs.renumber(blk);
  perform rs.notify('remove');
  return jsonb_build_object('ok', true);
end $$;

-- sobe (p_dir = -1) ou desce (p_dir = 1) um apresentador dentro do bloco
create or replace function public.rs_move(p_pin text, p_id text, p_dir int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := rs.check_pin(p_pin);
  blk text;
  my_order int;
  other_id text;
begin
  if e is not null then return rs.err(e); end if;
  if p_dir not in (-1, 1) then return rs.err('bad_dir'); end if;
  select block_id into blk from rs.registrations where id = p_id;
  if blk is null then return rs.err('not_found'); end if;

  perform 1 from rs.blocks where id = blk for update;
  perform rs.renumber(blk);
  select order_index into my_order from rs.registrations where id = p_id;
  select id into other_id from rs.registrations where block_id = blk and order_index = my_order + p_dir;
  if other_id is null then return jsonb_build_object('ok', true); end if;

  update rs.registrations set order_index = my_order where id = other_id;
  update rs.registrations set order_index = my_order + p_dir where id = p_id;
  perform rs.notify('move');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rs_reset(p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := rs.check_pin(p_pin);
begin
  if e is not null then return rs.err(e); end if;
  delete from rs.registrations where true;
  perform rs.notify('reset');
  return jsonb_build_object('ok', true);
end $$;

revoke all on function
  public.rs_list(),
  public.rs_register(text, text, text, text, text[], text),
  public.rs_cancel(text, text),
  public.rs_check_pin(text),
  public.rs_remove(text, text),
  public.rs_move(text, text, int),
  public.rs_reset(text)
from public;

grant execute on function
  public.rs_list(),
  public.rs_register(text, text, text, text, text[], text),
  public.rs_cancel(text, text),
  public.rs_check_pin(text),
  public.rs_remove(text, text),
  public.rs_move(text, text, int),
  public.rs_reset(text)
to anon, authenticated;

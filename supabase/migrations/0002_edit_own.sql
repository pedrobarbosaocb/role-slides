-- Rolê de Slides — quem se inscreveu pode editar a própria inscrição.
-- A autorização é a mesma do cancelamento: a chave secreta guardada no
-- navegador de quem se inscreveu (o banco só guarda o hash). Ninguém mais
-- consegue alterar a inscrição de outra pessoa. Rode no SQL Editor (idempotente).

create or replace function public.rs_update(
  p_id text, p_key text, p_name text, p_block text, p_topic_mode text, p_topic_title text, p_tech text[]
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r rs.registrations;
  cap int;
  taken int;
  next_order int;
  clean_name text := trim(coalesce(p_name, ''));
  clean_title text := trim(coalesce(p_topic_title, ''));
  clean_tech text[];
begin
  if p_key is null or char_length(p_key) < 16 or char_length(p_key) > 128 then return rs.err('forbidden'); end if;
  if char_length(clean_name) < 1 or char_length(clean_name) > 40 then return rs.err('bad_name'); end if;
  if p_topic_mode is null or p_topic_mode not in ('defined', 'secret', 'tbd') then return rs.err('bad_topic'); end if;
  if p_topic_mode = 'defined' then
    if char_length(clean_title) < 1 or char_length(clean_title) > 90 then return rs.err('bad_topic'); end if;
  else
    clean_title := '';
  end if;

  select coalesce(array_agg(distinct t), '{}') into clean_tech
  from unnest(coalesce(p_tech, '{}')) t
  where t in ('own_laptop', 'send_file', 'audio_out');

  select * into r from rs.registrations where id = p_id and owner_hash = rs.sha256(p_key);
  if r.id is null then return rs.err('forbidden'); end if;

  if p_block is distinct from r.block_id then
    -- trava os dois blocos (sempre na mesma ordem, para não dar deadlock)
    perform 1 from rs.blocks where id in (p_block, r.block_id) order by id for update;
    select capacity into cap from rs.blocks where id = p_block;
    if cap is null then return rs.err('bad_block'); end if;

    select count(*), coalesce(max(order_index), -1) + 1 into taken, next_order
    from rs.registrations where block_id = p_block;
    if taken >= cap then return rs.err('full'); end if;

    update rs.registrations set block_id = p_block, order_index = next_order where id = r.id;
    perform rs.renumber(r.block_id);
  end if;

  update rs.registrations
  set name = clean_name, topic_mode = p_topic_mode, topic_title = clean_title, tech = clean_tech
  where id = r.id;

  perform rs.notify('update');
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.rs_update(text, text, text, text, text, text, text[]) from public;
grant execute on function public.rs_update(text, text, text, text, text, text, text[]) to anon, authenticated;

-- =====================================================================
-- 이화산업 WMS - 전체 스키마 + 트랜잭션 RPC + 시드 (Claude ver.)
-- Supabase SQL Editor에 통째로 붙여넣어 실행하세요.
-- 사용자(users) 테이블은 ehwa_wms_users.sql 에서 별도로 생성합니다.
-- =====================================================================

-- ---------- 1) 테이블 ----------
create table if not exists public.item_types (
  code        text primary key,
  name        text,
  sort_order  int default 100,
  is_active   boolean default true
);

create table if not exists public.pallets (
  id                 text primary key,            -- 예: EH-0001
  target_factory     text not null,               -- 1공장 / 2공장 / 4공장
  status             text not null default 'EMPTY', -- EMPTY / LOADING / LOADED / SHIPPING
  location           text,
  destination        text,
  current_item_type  text,
  current_item_count int  not null default 0,
  loaded_at          timestamptz,
  outbound_at        timestamptz
);

create table if not exists public.items (
  item_qr     text primary key,
  item_type   text,
  item_name   text,
  status      text default 'AVAILABLE'            -- AVAILABLE / LOADED
);

create table if not exists public.pallet_load_items (
  id          bigint generated always as identity primary key,
  pallet_id   text not null,
  item_qr     text not null unique,               -- 제품 QR은 전체에서 한 번만 적재 (중복 차단)
  item_type   text,
  scanned_by  text,
  scanned_at  timestamptz not null default now()
);
create index if not exists idx_pli_pallet on public.pallet_load_items(pallet_id);

create table if not exists public.pallet_logs (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  username    text,
  event       text,
  pallet_id   text,
  item_qr     text,
  item_type   text,
  message     text
);
create index if not exists idx_logs_at on public.pallet_logs(at desc);

-- ---------- 2) 제품 타입 / 샘플 제품 시드 ----------
insert into public.item_types (code, name, sort_order, is_active) values
  ('2M800','용기 코드 2M800',10,true),
  ('2S600','용기 코드 2S600',20,true),
  ('2S003','용기 코드 2S003',30,true),
  ('2MRA0','용기 코드 2MRA0',40,true),
  ('2M701','용기 코드 2M701',50,true),
  ('2MTA0','용기 코드 2MTA0',60,true)
on conflict (code) do update set name=excluded.name, sort_order=excluded.sort_order, is_active=excluded.is_active;

insert into public.items (item_qr, item_type, item_name, status) values
  ('L5012504010350022M800','2M800','샘플 제품 2M800','AVAILABLE'),
  ('L5012504020450022S600','2S600','샘플 제품 2S600','AVAILABLE'),
  ('L6012504010350022S003','2S003','샘플 제품 2S003','AVAILABLE'),
  ('L5032504010350022MRA0','2MRA0','샘플 제품 2MRA0','AVAILABLE'),
  ('L4012512100350022M701','2M701','샘플 제품 2M701','AVAILABLE'),
  ('L5012504010350072MTA0','2MTA0','샘플 제품 2MTA0','AVAILABLE')
on conflict (item_qr) do update set item_type=excluded.item_type, item_name=excluded.item_name, status=excluded.status;

-- ---------- 3) 파레트 1,700개 시드 (1공장 500 / 2공장 500 / 4공장 700) ----------
insert into public.pallets (id, target_factory, status, location)
select
  'EH-' || lpad(n::text, 4, '0'),
  case when n <= 500 then '1공장' when n <= 1000 then '2공장' else '4공장' end,
  'EMPTY',
  (case when n <= 500 then '1공장' when n <= 1000 then '2공장' else '4공장' end)
    || ' A-' || lpad(((n % 40) + 1)::text, 2, '0')
from generate_series(1, 1700) as g(n)
on conflict (id) do nothing;

-- ---------- 4) 제품 타입 추출 함수 ----------
create or replace function public.extract_item_type(p_qr text)
returns text language plpgsql immutable as $$
declare v text := upper(trim(p_qr));
begin
  if    v ~ 'M800$' then return '2M800';
  elsif v ~ 'S600$' then return '2S600';
  elsif v ~ 'S003$' then return '2S003';
  elsif v ~ 'MRA0$' then return '2MRA0';
  elsif v ~ 'M701$' then return '2M701';
  elsif v ~ 'MTA0$' then return '2MTA0';
  else return null;
  end if;
end; $$;

-- ---------- 5) 적재 RPC (검증 + 적재 + 로그를 한 트랜잭션으로) ----------
create or replace function public.load_product_to_pallet(p_pallet_id text, p_item_qr text, p_user_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_qr text := upper(trim(p_item_qr));
  v_type text;
  v_pallet pallets%rowtype;
  v_count int;
  v_full boolean;
  v_status text;
begin
  v_type := extract_item_type(v_qr);
  if v_type is null then
    return jsonb_build_object('ok',false,'error_code','UNKNOWN_TYPE','message','제품 타입을 판별할 수 없습니다: '||v_qr);
  end if;

  select * into v_pallet from pallets where id = p_pallet_id;
  if not found then
    return jsonb_build_object('ok',false,'error_code','NO_PALLET','message',p_pallet_id||' 파레트를 찾을 수 없습니다.');
  end if;
  if v_pallet.status = 'SHIPPING' then
    return jsonb_build_object('ok',false,'error_code','SHIPPED','message',p_pallet_id||'은 이미 상차/운송 처리되어 적재할 수 없습니다.');
  end if;

  -- 중복 QR 차단
  if exists (select 1 from pallet_load_items where item_qr = v_qr) then
    return jsonb_build_object('ok',false,'error_code','DUPLICATE','message','중복 QR입니다. '||v_qr||' 은 이미 적재되어 있습니다.');
  end if;

  -- 혼적 차단
  if v_pallet.current_item_type is not null and v_pallet.current_item_type <> v_type then
    insert into pallet_logs(username,event,pallet_id,item_qr,item_type,message)
      values(p_user_name,'혼적 경고',p_pallet_id,v_qr,v_type,
             '현재 파레트에는 '||v_pallet.current_item_type||'이 적재되어 있습니다. '||v_type||'은 혼적입니다.');
    return jsonb_build_object('ok',false,'error_code','MIXED',
      'message','현재 파레트에는 '||v_pallet.current_item_type||'이 적재되어 있습니다. '||v_type||'은 혼적입니다.');
  end if;

  -- 적재
  insert into pallet_load_items(pallet_id,item_qr,item_type,scanned_by) values(p_pallet_id,v_qr,v_type,p_user_name);
  v_count  := v_pallet.current_item_count + 1;
  v_full   := v_count >= 9;
  v_status := case when v_full then 'LOADED' else 'LOADING' end;

  update pallets set current_item_type=v_type, current_item_count=v_count, status=v_status,
         loaded_at = case when v_full then now() else loaded_at end
   where id = p_pallet_id;
  update items set status='LOADED' where item_qr = v_qr;

  insert into pallet_logs(username,event,pallet_id,item_qr,item_type,message)
    values(p_user_name, case when v_full then '적재 완료' else '제품 QR 적재' end, p_pallet_id, v_qr, v_type,
           case when v_full then p_pallet_id||' '||v_type||' 적재 완료' else v_type||' 적재 ('||v_count||'/9)' end);

  return jsonb_build_object('ok',true,'item_type',v_type,'current_count',v_count,'pallet_status',v_status,
    'reached_full',v_full,'message', case when v_full then p_pallet_id||' 적재 완료' else '적재 '||v_count||'/9 · '||v_type end);
exception when unique_violation then
  return jsonb_build_object('ok',false,'error_code','DUPLICATE','message','중복 QR입니다: '||v_qr);
end; $$;

-- ---------- 6) 적재 취소 RPC ----------
create or replace function public.remove_item_from_pallet(p_pallet_id text, p_item_qr text, p_user_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_qr text := upper(trim(p_item_qr)); v_count int; v_status text; v_type text;
begin
  delete from pallet_load_items where pallet_id = p_pallet_id and item_qr = v_qr;
  select count(*) into v_count from pallet_load_items where pallet_id = p_pallet_id;
  if v_count = 0 then
    v_type := null; v_status := 'EMPTY';
  else
    select item_type into v_type from pallet_load_items where pallet_id = p_pallet_id limit 1;
    v_status := 'LOADING';
  end if;
  update pallets set current_item_count=v_count, current_item_type=v_type, status=v_status,
         loaded_at = case when v_count < 9 then null else loaded_at end
   where id = p_pallet_id;
  update items set status='AVAILABLE' where item_qr = v_qr;
  insert into pallet_logs(username,event,pallet_id,item_qr,item_type,message)
    values(p_user_name,'적재 취소',p_pallet_id,v_qr,v_type,v_qr||' 적재 취소(되돌림)');
  return jsonb_build_object('ok',true,'current_count',v_count,'pallet_status',v_status,'item_type',v_type);
end; $$;

-- ---------- 7) 상차 / 초기화 RPC ----------
create or replace function public.ship_pallet(p_pallet_id text, p_user_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update pallets set status='SHIPPING', outbound_at=now()
   where id = p_pallet_id and status='LOADED';
  insert into pallet_logs(username,event,pallet_id,message) values(p_user_name,'상차/운송',p_pallet_id,p_pallet_id||' 상차 처리');
  return jsonb_build_object('ok',true);
end; $$;

create or replace function public.reset_pallet(p_pallet_id text, p_user_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update items set status='AVAILABLE'
   where item_qr in (select item_qr from pallet_load_items where pallet_id = p_pallet_id);
  delete from pallet_load_items where pallet_id = p_pallet_id;
  update pallets set status='EMPTY', current_item_type=null, current_item_count=0, loaded_at=null, outbound_at=null
   where id = p_pallet_id;
  insert into pallet_logs(username,event,pallet_id,message) values(p_user_name,'파레트 초기화',p_pallet_id,p_pallet_id||' 초기화(회수)');
  return jsonb_build_object('ok',true);
end; $$;

-- ---------- 8) 권한 (RPC 실행) ----------
grant execute on function public.extract_item_type(text)                       to anon, authenticated;
grant execute on function public.load_product_to_pallet(text,text,text)        to anon, authenticated;
grant execute on function public.remove_item_from_pallet(text,text,text)       to anon, authenticated;
grant execute on function public.ship_pallet(text,text)                        to anon, authenticated;
grant execute on function public.reset_pallet(text,text)                       to anon, authenticated;

-- ---------- 9) RLS (행 수준 보안) ----------
-- 파일럿/현장 테스트용 설정입니다. 읽기는 익명 허용, 쓰기 검증은 위 RPC(security definer)가 담당합니다.
-- 제품 QR/타입 등록(관리자 화면)은 REST 직접 쓰기를 쓰므로 items/item_types에만 쓰기 정책을 엽니다.
-- ※ 외부 인터넷에 공개 배포한다면, 운영 단계에서는 인증 기반으로 반드시 조여야 합니다.
alter table public.pallets           enable row level security;
alter table public.items             enable row level security;
alter table public.item_types        enable row level security;
alter table public.pallet_load_items enable row level security;
alter table public.pallet_logs       enable row level security;

do $$ begin
  -- 읽기 (모든 테이블)
  perform 1;
end $$;

drop policy if exists rd_pallets   on public.pallets;           create policy rd_pallets   on public.pallets           for select to anon, authenticated using (true);
drop policy if exists rd_items     on public.items;             create policy rd_items     on public.items             for select to anon, authenticated using (true);
drop policy if exists rd_types     on public.item_types;        create policy rd_types     on public.item_types        for select to anon, authenticated using (true);
drop policy if exists rd_pli       on public.pallet_load_items; create policy rd_pli       on public.pallet_load_items for select to anon, authenticated using (true);
drop policy if exists rd_logs      on public.pallet_logs;       create policy rd_logs      on public.pallet_logs       for select to anon, authenticated using (true);

-- 제품/타입 등록·삭제 (관리자 화면의 REST 직접 쓰기용)
drop policy if exists wr_items     on public.items;
create policy wr_items on public.items for all to anon, authenticated using (true) with check (true);
drop policy if exists wr_types     on public.item_types;
create policy wr_types on public.item_types for all to anon, authenticated using (true) with check (true);

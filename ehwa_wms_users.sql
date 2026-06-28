-- =====================================================================
-- 이화산업 WMS - 사용자(로그인) 테이블
-- admin_type: 1 = 관리자(관리자 페이지 접근 가능), 2 = 작업자(작업 화면만)
-- Supabase SQL Editor에 그대로 붙여넣어 실행하세요.
-- =====================================================================

create table if not exists public.users (
  id          bigint generated always as identity primary key,
  username    text        not null unique,
  password    text        not null,                 -- ※ 운영 단계에서는 평문 대신 해시 저장 권장
  name        text,
  admin_type  smallint    not null default 2,        -- 1=관리자, 2=작업자
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

comment on column public.users.admin_type is '1=관리자(관리자페이지 접근), 2=작업자';

-- 계정 시드 (요청 사양)
insert into public.users (username, password, name, admin_type) values
  ('admin',  'admin1234', '관리자',     1),   -- 관리자
  ('ewha01', 'ewha01',    '현장 작업자', 2)    -- 작업자
on conflict (username) do update
set password   = excluded.password,
    name       = excluded.name,
    admin_type = excluded.admin_type;

-- =====================================================================
-- RLS (행 수준 보안)
-- 아래는 "익명 키로 로그인 조회"를 허용하는 가장 단순한 설정입니다.
-- 프론트엔드(App.jsx)가 anon 키로 username 행을 읽어 비밀번호를 비교하는 방식과 짝을 이룹니다.
-- =====================================================================
alter table public.users enable row level security;

drop policy if exists users_select_for_login on public.users;
create policy users_select_for_login
  on public.users for select
  to anon, authenticated
  using (is_active = true);

-- =====================================================================
-- (권장) 더 안전한 방식: 비밀번호를 클라이언트로 내려보내지 않는 RPC 로그인
-- 위 select 정책 대신 이 함수를 쓰면 password 컬럼이 외부로 노출되지 않습니다.
-- 사용 시: App.jsx 의 signIn 을 fetch(.../rest/v1/users...) 대신
--          fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_login`, { method:'POST', body: JSON.stringify({ p_username, p_password }) }) 로 변경.
-- =====================================================================
create or replace function public.verify_login(p_username text, p_password text)
returns table (username text, name text, admin_type smallint)
language sql
security definer
set search_path = public
as $$
  select u.username, u.name, u.admin_type
  from public.users u
  where u.username = p_username
    and u.password = p_password
    and u.is_active = true
  limit 1;
$$;

grant execute on function public.verify_login(text, text) to anon, authenticated;

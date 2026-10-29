-- =========================================================
-- 词汇测验 · 成绩云端同步 · Supabase 一键初始化
-- ---------------------------------------------------------
-- 用法：Supabase 控制台 → 左侧 SQL Editor → New query →
--       整段粘贴 → Run。跑一次即可，重复跑也安全。
--
-- 跑完请把下面第 3 步里的「教师口令」换成你自己的，
-- 并保持和 index.html 里 cloud-config 的 teacherCode 一致。
-- =========================================================

-- ---------- 1. 成绩表 ----------
create table if not exists public.gk_scores (
  id          bigserial primary key,
  quiz_code   text        not null default 'UNKNOWN',
  quiz_name   text        not null default '',
  student_name text       not null default '匿名学生',
  score       int         not null default 0,
  correct     int         not null default 0,
  total       int         not null default 0,
  seconds     int         not null default 0,
  wrong_words jsonb       not null default '[]'::jsonb,
  device      text        not null default '',
  client_at   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists gk_scores_code_time_idx on public.gk_scores (quiz_code, client_at desc);
create index if not exists gk_scores_time_idx       on public.gk_scores (client_at desc);

-- ---------- 2. 开启行级安全（RLS） ----------
alter table public.gk_scores enable row level security;

-- 学生端：只允许插入，任何人（anon）都能交卷
drop policy if exists "students can submit score" on public.gk_scores;
create policy "students can submit score"
  on public.gk_scores for insert
  to anon, authenticated
  with check (true);

-- 注意：这里刻意不建任何 SELECT 策略。
-- 所以 anon key 直接 GET /rest/v1/gk_scores 只会拿到空数组 []，
-- 全班成绩不会因为前端代码公开而泄露。教师端读取走下面的 RPC。

-- ---------- 3. 教师读取函数（带口令校验） ----------
-- ⚠️ 把 'CHANGE-ME-2026' 换成你自己的教师口令（建议 8 位以上，
--    含字母数字）。这个口令同时填进 index.html 的 teacherCode。
create or replace function public.teacher_scores(
  p_pass  text,
  p_code  text default null,
  p_limit int  default 1000
)
returns table (
  id           bigint,
  quiz_code    text,
  quiz_name    text,
  student_name text,
  score        int,
  correct      int,
  total        int,
  seconds      int,
  wrong_words  jsonb,
  client_at    timestamptz
)
language sql
security definer
set search_path = public
as $$
  select s.id, s.quiz_code, s.quiz_name, s.student_name, s.score,
         s.correct, s.total, s.seconds, s.wrong_words, s.client_at
  from public.gk_scores s
  where p_pass = 'vhobkjbiorgzewellbaf'
    and (p_code is null or upper(s.quiz_code) = upper(p_code))
  order by s.client_at desc
  limit least(coalesce(p_limit, 1000), 5000);
$$;

-- 函数允许匿名调用（口令校验在函数体内）
revoke all on function public.teacher_scores(text, text, int) from public;
grant execute on function public.teacher_scores(text, text, int) to anon, authenticated;

-- ---------- 4. 习题文件存储桶（微信下载用） ----------
-- 微信内置浏览器不能下载 blob: 链接，但能下载 http 直链的 .pdf。
-- 所以手机端把练习 PDF 传到这里，再把公开直链给微信去下载。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'worksheets', 'worksheets', true, 5242880,
  array['application/pdf','text/html','application/msword']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['application/pdf','text/html','application/msword'];

-- 允许任何人上传（学生手机端没有账号）
drop policy if exists "anon can upload worksheets" on storage.objects;
create policy "anon can upload worksheets"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'worksheets');

-- 允许读取/列出（公开桶，微信要能直接访问链接）
drop policy if exists "anon can read worksheets" on storage.objects;
create policy "anon can read worksheets"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'worksheets');

-- 允许覆盖同名文件（重复生成时不会报 already exists）
drop policy if exists "anon can update worksheets" on storage.objects;
create policy "anon can update worksheets"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'worksheets')
  with check (bucket_id = 'worksheets');

-- ---------- 5. 自检 ----------
-- 跑完可以执行下面几句确认：
--   select count(*) from public.gk_scores;
--   select * from public.teacher_scores('vhobkjbiorgzewellbaf', null, 1);
--   select id, public from storage.buckets where id = 'worksheets';

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

-- ---------- 4. 自检 ----------
-- 跑完可以执行下面这句确认表建好了：
--   select count(*) from public.gk_scores;
-- 以及确认 RPC 通（应返回空集合，不报错）：
--   select * from public.teacher_scores('CHANGE-ME-2026', null, 1);

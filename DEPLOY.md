# 部署到 GitHub Pages（3 分钟）

## 方式一：网页上传（无需装任何工具）

1. 打开 https://github.com/new ，仓库名填 `vocab-quiz`，选 **Public**，点 Create repository
2. 在新仓库页点 **uploading an existing file**
3. 把本文件夹里的**所有文件和 data 文件夹**拖进去（注意：`index.html` 必须在仓库根目录）
4. 点 **Commit changes**
5. 进入仓库 **Settings → Pages**
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，目录选 **/ (root)**，点 Save
6. 等 1–2 分钟，访问：`https://<你的用户名>.github.io/vocab-quiz/`

## 方式二：命令行

```bash
cd 本文件夹
git init && git add -A && git commit -m "vocab quiz"
git branch -M main
git remote add origin https://github.com/<你的用户名>/vocab-quiz.git
git push -u origin main
```
然后在 Settings → Pages 里开启 main / root。

## 部署后要改的一处

`index.html` 里 `data/vials.json` 只是发布记录，不需要删除，但**不要**把它当页面访问。

## 学生链接长什么样

- 入口：`https://<用户名>.github.io/vocab-quiz/`
- 短链：`https://<用户名>.github.io/vocab-quiz/?c=00000000`（二维码里就是这个）

> GitHub Pages 不拦截微信 UA，微信内可直接打开答题。

## 账号与密钥（运维备忘）

- Supabase 项目：`https://vhobkjbiorgzewellbaf.supabase.co`
- Storage 桶：`worksheets`（PDF）、`assets`（前端资源 + 发布批次 `data/vials.json`）
- 批次密钥：固定 `0123456789abc`（13 位 [0-9a-f]）。**改密钥会让所有已发出的短链失效**，
  `app.js` 里的 `PW_DEFAULT`、`runner.js` 里的默认值要同步改。

## 一键发布（教师端）

教师建好测验 → 弹窗点「发布上线」→ 前端把批次（含完整卷面）推到 `assets/data/vials.json`
→ 后台 runner 取走、合并历史批次、重新打包、提交 `index.html` 到 GitHub Pages
→ 前端每 5 秒轮询，页面自动出现二维码，全程无需人工。

runner 部署：

```bash
GITHUB_TOKEN=<contents:write 的 PAT> POLL_SECONDS=60 node runner.js
```

要点：
- 必须**合并**而不是覆盖线上批次，否则此前发布的卷全部失效（`runner.js` 用
  `data/vials-full.json` 作为历史基线，前端也会先拉云端批次再合并，双保险）。
- `pack-share.js` 不再把 `data/vials.json` 覆盖成摘要：完整卷面写 `data/vials-full.json`，
  摘要写 `data/vials-toc.json`。之前用摘要覆盖导致"再打包就没题目了"。
- runner 打包后会**等待线上密文真的变化**（最多 3 分钟）才回写发布状态，
  避免前端看到旧页面而一直卡在等待态。

## 2026-10-30 排障记录：位流三处错位（已修）

新题型「英语知识运用」上线后出现「题干和选项对不上」。根因是编解码两端不一致，共三处：

1. **选项引用存错下标**：pack-share 存了「按 tier 排序后的名次」，解码端 `builtinAt(ref)=vocab[ref]` 按原始下标取词 → 全卷错位。改为存原始下标。
2. **附注区被去重**：解码端按 `0xfff` 出现顺序逐条消费附注，打包端却去重 → 后续条目整体错位。改为不去重，重复词各占一条。
3. **位数偏移**：题型字段从 1 位扩到 2 位后，选项引用起始位置从 bit3 移到 bit4；`ai`（正确项）也应在 bit2 而不是 bit1。两端必须同步为 `type(2)+ai(2)+4×12`。

排查手段：解密密文后直接比对位流字段，比页面现象更快。

## runner 合并策略升级：按「坏题数」择优

云端批次可能残留旧脏数据（`?` / `undefined` / 空释义）。runner 现在对同 code 冲突按坏题数比较，保留更干净的版本，避免修复过的干净数据被云端旧数据反向覆盖。

## 联调试卷 ACDE34

线上保留一份 8 题的小卷（英译中 3 / 中译英 3 / 英语知识运用 2），用于验证三种题型全链路。源码见 `tools-build-batch.js`，需要时 `node tools-build-batch.js && node pack-share.js` 重新生成。

## 公网访问（现状）

站点已是公网可访问：**https://duozhid.github.io/vocab-quiz/**
- 仓库 `duozhid/vocab-quiz` 为 public，GitHub Pages 已开启，任何人（含微信内）可直接打开
- 无服务器成本，静态托管；数据在 Supabase（免费额度）

## 发布流水线的三种运行方式

老师点「发布上线」后，需要有个「搬运工」把批次重打包并提交到 Pages。按可靠性排序：

| 方式 | 是否需要常开电脑 | 说明 |
|---|---|---|
| **GitHub Actions**（推荐） | 不需要 | `runner.js --once` 每 5 分钟跑一轮；文件见 `.github/workflows/publish.yml` |
| 自己的服务器 / 云函数 | 需要（或定时触发） | `node runner.js` 常驻，或 cron 调 `--once` |
| 本机手动 | 不需要 | 老师点「导出备份」后手动上传 index.html |

### 启用 GitHub Actions 的两个前置步骤

1. **首次必须用网页端创建 workflow 文件**：GitHub 禁止用 PAT 通过 API 创建 `.github/workflows/*`（会返回 403）。
   把本地 `.github/workflows/publish.yml` 的内容复制到仓库网页 → Add file → Create new file → 路径填
   `.github/workflows/publish.yml` → 粘贴 → Commit。
2. 仓库 Settings → Secrets and variables → Actions → Variables 添加 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`
   （不配也能从 index.html 的 cloud-config 自动读取，但显式配置更清晰）。

启用后可在 Actions 页面点「Run workflow」手动触发一次，验证是否正常打包上线。

## 沙箱 runner 的局限

当前沙箱里的 `node runner.js --once` 只在沙箱存活期间有效。沙箱休眠后，
「点发布 → 二维码自动出现」会退化为「导出备份 → 手动上传」。
长期使用请按上表切到 GitHub Actions。

## 发布不再依赖 runner（浏览器端打包）

GitHub 网页打不开、或没有常开机器时，原来的「runner 定时打包」就用不了。
现在把打包搬到浏览器里（`ShareCodec.packVial`，与解码严格对称）：

老师点「发布上线」→ 浏览器本地用 WebCrypto 打包并加密 → 通过 GitHub Contents API
直接提交 index.html → Pages 自动重建。全程不经过任何服务器。

- 令牌只存老师本机 localStorage，不上传
- 没配令牌时会退化为「下载打好补丁的 index.html」，手动替换也能上线
- 提交后本地立刻按新密文渲染二维码，不必等 Pages 缓存刷新（约 1 分钟）

验证：10 份卷往返打包→解码，题面/选项/正确答案完全一致。

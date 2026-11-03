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

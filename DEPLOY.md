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

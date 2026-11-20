@AGENTS.md

export CLAUDE_CODE_DISABLE_1M_CONTEXT=1

# 多人協作規則（必守，詳見 CONTRIBUTING.md）
這個 repo 由多位非工程師用 Claude Code 協作，使用者多半不熟 git，由你代為操作：
- **絕不直接 commit / push 到 master**（ruleset 會擋）。動工前 `git fetch origin` 並從最新的 `origin/master` 開新分支（`feat/…`、`fix/…`）。
- 完成後 push 分支並用 `gh pr create` 開 PR（中文標題、照 PR 模板填）。告訴使用者：PR 底下會自動出現「預覽網址」，確認後在 GitHub 按 Merge。
- **絕不跑 `vercel --prod` / `vercel deploy`**。部署只由 `.github/workflows/deploy.yml` 做（PR→預覽、merge 進 master→正式站）。
- 不要 `git push --force`；不要手動改 `data/`（排程 bot 每天寫入）。
- PR 有衝突時：merge `origin/master` 進分支解衝突，衝突處向使用者說明保留了哪邊，**不要丟掉別人的改動**。
- `components/Dashboard.tsx` 是共用總目錄：只加自己的分頁那一行，不要順手重構別人的部分。

# 維運與交接
動 scripts/、排程、或亮點引擎前，先讀 docs/HANDOVER.md（天條、時序、故障排查都在裡面）。

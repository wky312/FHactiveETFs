# 協作說明（給不是工程師的你）

這個網站（https://fhactiveetf.vercel.app）由幾個人一起用 Claude Code 改。
規則只有一個目的：**大家的改動不會互相蓋掉，正式站永遠是大家都看過的版本。**

## 一句話流程

> 開分支改 → 送 Pull Request → 看預覽網址 → 有人按 Merge → 自動上線

你不用記 git 指令，跟 Claude 說「照 CONTRIBUTING.md 的流程做」就好，它會處理。

## 詳細步驟

1. **開始前**：在 claude.ai/code（或本機 Claude Code）打開這個 repo `wky312/FHactiveETFs`。
2. **說你要做什麼**：例如「在績效分頁加一個 00981A 的比較圖」。
   Claude 會自動從最新的 master 開一個新分支（例如 `feat/00981a-compare`）來改。
3. **改好後**：跟 Claude 說「送 PR」。它會 push 分支並在 GitHub 開一個 Pull Request。
4. **看預覽**：一兩分鐘後，PR 底下會自動出現一則留言 🔍 **預覽網址**。
   點開就是「套用你的改動後」的網站，正式站完全不受影響。可以把網址丟給其他人一起看。
5. **要再修**：繼續跟 Claude 說要改什麼，它推新的 commit 後，預覽網址會自動更新。
6. **上線**：確認沒問題，在 GitHub 的 PR 頁面按綠色 **Merge** 按鈕。
   幾分鐘後正式站就更新了。Merge 後分支可以刪掉。

## 鐵則（Claude 也會遵守）

| ✅ 要 | ❌ 不要 |
|---|---|
| 每個功能開一個新分支、一個 PR | 直接改 master（系統會擋） |
| PR 小而快：當天開、當天 merge | 一個分支放好幾天、塞一堆功能（越久越容易衝突） |
| 動手前先同步最新 master | 用 `git push --force`（系統會擋） |
| 上線只靠 merge | 從自己電腦跑 `vercel --prod`（會把別人的功能蓋掉） |
| 改程式碼、文字、設定 | 手動改 `data/` 資料夾（那是每天自動排程寫的） |

## 分工建議（減少撞車）

盡量每個人負責不同的分頁或檔案。分頁大多是 `components/` 底下各自一個 `XxxTab.tsx`，
**`components/Dashboard.tsx` 是所有分頁的總目錄，大家都會碰到**——新增分頁時只加自己那一行，不要順手整理別人的部分。

## 遇到狀況

- **PR 顯示「This branch has conflicts」**：有人先改了同一段。跟 Claude 說「幫我把 master 合進來並解決衝突」，看它怎麼處理再確認。
- **預覽網址沒出現**：到 PR 頁面的 Checks / Actions 看「Deploy to Vercel」有沒有紅叉，把錯誤訊息貼給 Claude。
- **預覽站某些分頁是空的**：「受益人數」「單位數注意商品」「同業申贖觀測」需要寫入權限的資料庫金鑰，預覽站刻意不給，正式站正常就好。
- **不小心 merge 了有問題的東西**：在 GitHub 那個 PR 頁面按 **Revert**，再 merge 那個 revert PR 即可還原。

## 只有 repo 擁有者管的事

Vercel 設定、環境變數（API 金鑰）、GitHub Secrets、排程。協作者不需要 Vercel 帳號。

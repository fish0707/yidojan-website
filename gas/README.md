# 午餐訂單彙整系統 — 部署說明

這套工具跟飲料店那組（`admin.html` / `liff_order.html` / `ipad_dashboard.html`）**完全獨立**，
請另外開一個 Google 試算表與一個 Apps Script 專案，不要共用同一份 `GAS_URL`。

## 檔案

| 檔案 | 用途 |
|---|---|
| `lunch.html` | 同事點餐頁（手機優先） |
| `lunch_admin.html` | 主揪頁：開單、收單、彙整、菜單維護、歷史 |
| `lunch_wheel.html` | 吃什麼轉盤：隨機抽 5 間轉，轉到哪間就帶出那間的菜單 |
| `lunch.js` | 兩頁共用的 API 與工具函式，`GAS_URL` 也在這裡 |
| `gas/lunch_Code.gs` | 後端程式碼，貼進 Apps Script 編輯器 |
| `gas/appsscript.json` | 資訊清單（選用），設定時區與網頁應用程式參數 |

## 部署步驟

1. **建立試算表**：到 Google 雲端硬碟新增一份試算表，命名例如「午餐訂單」。
2. **開啟 Apps Script**：在試算表選單點 `擴充功能 → Apps Script`。
3. **貼上程式碼**：把 `gas/lunch_Code.gs` 的全部內容貼進 `Code.gs`（覆蓋原本的內容），存檔。
4. **初始化工作表**：在編輯器上方的函式下拉選單選 `setupSheets`，按執行。
   第一次會要求授權，同意即可。執行完會自動建好四張工作表與一間範例餐廳。
4.5. **完成授權**：函式下拉選單選 `authorizeAndSelfTest`，按執行，同意所有權限。
   詳見下面的〈授權〉一節 —— **這一步漏掉的話菜單辨識一定會失敗**。
5. **部署為網頁應用程式**：點右上角 `部署 → 新增部署作業`，類型選「網頁應用程式」，
   - 執行身分：**我**
   - 具有存取權的使用者：**任何人**（同事不用登入 Google 才點得到）
6. **複製網址**：部署後會給一段 `https://script.google.com/macros/s/AKfy.../exec`，
   把它貼進 `lunch.js` 第 8 行的 `GAS_URL`。
7. 把 `lunch.html` / `lunch_admin.html` / `lunch_wheel.html` / `lunch.js` 一起放上網站（推上 `main`，Vercel 會自動部署）。
8. **（選用）啟用菜單 DM 辨識** —— 見下一節。

> **改過程式碼要重新部署**：Apps Script 每次改完要點 `部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署`，
> 網址不會變。若選「新增部署作業」則會產生新網址，`lunch.js` 也要跟著換。

## 授權（重要）

Apps Script 的權限是**依「程式碼用到哪些 Google 服務」決定的**，而且是在你第一次按下
「允許」時就定下來。日後程式碼新增用到別的服務，**舊的授權不會自動涵蓋新的**，
呼叫時會被 Apps Script 在本機端直接擋下來，請求根本送不出去。

這個工具目前用到三種服務：

| 服務 | 用途 | 權限範圍 |
|---|---|---|
| `SpreadsheetApp` | 讀寫訂單與菜單 | `spreadsheets` |
| `UrlFetchApp` | 呼叫 Gemini 辨識菜單 | `script.external_request` |
| `DriveApp` | 儲存菜單 DM 原圖 | `drive` |

### 怎麼完成授權

在編輯器的函式下拉選單選 **`authorizeAndSelfTest`** → 執行 → 同意所有權限。

因為是你自己的未驗證專案，同意畫面會出現「Google 尚未驗證這個應用程式」的警告，
點「**進階**」→「**前往〈專案名稱〉（不安全）**」即可。那個「不安全」指的是
Google 沒有審核過這支腳本，而它就是你自己貼上去的。

執行完看下方的「**執行紀錄**」，它會逐項回報：試算表、Drive、對外連線、
API key 是否有效、**你的金鑰實際可用的模型清單**，最後實跑一次辨識。

> **每次貼上新版程式碼、或新增用到新的 Google 服務，都要重跑一次這支函式**，
> 然後再重新部署。

### 關於 `appsscript.json`

這個檔案**刻意不列 `oauthScopes`**，讓 Apps Script 依程式碼自動推斷需要哪些權限。

自己手寫權限清單看似嚴謹，實際上是個陷阱：一旦寫了，Apps Script 就停止自動偵測、
只認你列的那幾項，日後程式碼多用了一個服務就會在執行時被擋，而且**不會跳同意畫面**
（因為它認為清單裡的權限都拿到了），很難查。交給自動偵測反而穩。

這個檔案是選用的。要用的話到「**專案設定**」勾選
「**顯示 appsscript.json 資訊清單檔案**」再貼上。

## 菜單 DM 辨識（選用）

主揪頁的「餐廳菜單」分頁可以上傳一張菜單 DM 的照片，自動讀出品項與價格。
用的是 **Google Gemini API 的免費方案**，不用信用卡。

### 設定步驟

1. 到 [Google AI Studio](https://aistudio.google.com/apikey) 用你的 Google 帳號建立一組 API key（免費）。
2. 回到 Apps Script 編輯器 → 左邊齒輪「專案設定」→ 最下面「指令碼屬性」→ 新增：
   - 屬性名稱：`GEMINI_API_KEY`
   - 值：剛剛複製的 key
3. 存檔。**不用重新部署**，指令碼屬性是即時生效的。

> API key 只存在 Apps Script 的指令碼屬性裡，不會進 repo、也不會送到瀏覽器。
> 千萬不要把 key 寫進 `lunch.js` —— 這個 repo 和網站都是公開的，會被盜刷。

### 使用流程

主揪頁 →「餐廳菜單」分頁 → 選擇圖片 → 等約 10 秒 →
出現**確認畫面**（左邊是可編輯的品項表、右邊是原圖）→ 改好按「確認並套用」。

辨識結果**一定要人工看過**。DM 拍歪、印刷模糊、手寫加價都可能讀錯，
而價格錯了會直接變成大家收錢的依據，所以這道確認關卡不能省。

可以選擇套用到現有餐廳（取代整份菜單或追加）或建立新餐廳。
若 DM 上有店名且跟現有餐廳同名，系統會自動幫你選好。

### 原始 DM 圖片

套用時原圖會存進你 Google Drive 的「午餐菜單DM」資料夾，
權限設為「知道連結的人可以檢視」，點餐頁會出現「看原始菜單 DM」連結，
讓同事可以自己對照有沒有漏掉的品項。

第一次執行會要求授權 Drive 權限（因為新增了 `DriveApp` 的使用），
在 Apps Script 裡跑一次 `setupSheets` 或直接在網頁上傳一張圖時會跳出授權畫面，同意即可。
存圖失敗不會讓整個套用失敗 —— 菜單本身才是重點。

### 模型設定

預設模型寫在 `lunch_Code.gs` 的 `GEMINI_MODEL_DEFAULT`（目前是 `gemini-3.5-flash`），
但**可以用指令碼屬性 `GEMINI_MODEL` 覆蓋**（不用改程式碼、不用重新部署）。

熱門的舊模型（例如 `gemini-2.5-flash`）常常回 503「high demand」。
程式碰到 5xx 會自動重試 3 次並遞增退避，但如果某個模型持續壅塞，換一個比較快。

Google 會汰換模型名稱，所以不要靠猜的 —— 執行 `authorizeAndSelfTest`，
執行紀錄會列出**你的金鑰當下實際可用的模型**，挑一個 flash 系列填進
`GEMINI_MODEL` 即可。若目前設定的模型已經下架，那支函式也會直接告訴你並建議替代品。

### 額度與限制

免費方案有每分鐘／每日的請求上限。以「偶爾傳一張菜單」的用量來說遠遠夠用，
碰到上限時後端會回「辨識額度用完了」，過一陣子或隔天就恢復。

免費方案的內容政策會隨時間調整（例如 2026 年 4 月起 Pro 系列改為付費、Flash 系列
維持免費）。以 `authorizeAndSelfTest` 列出的清單為準最可靠。

另外，Google 免費方案的資料可能被用於改善其產品；傳的是餐廳 DM，通常不成問題，
但還是先知道為好。

## 吃什麼轉盤（`lunch_wheel.html`）

選擇困難的時候用的。從**有上架品項的餐廳**裡隨機抽 5 間放上轉盤，轉到哪間就直接
帶出那間的完整菜單，旁邊有「用這間開單 →」可以帶著餐廳跳到主揪頁（`?r=<restaurantId>`，
下拉選單會預先選好）。

- 停用的餐廳、以及一個上架品項都沒有的餐廳不會進轉盤——轉到空菜單這遊戲就白玩了。
- 餐廳不到 5 間就有幾間放幾間；只有 1 間時直接顯示那間，不用抽。
- **不需要任何後端改動**：`getRestaurants` 本來就會連菜單一起回傳，整頁只打一次 API。
- 贏家是「先抽好、再回推轉盤該停在哪個角度」。反過來做（轉完再看指針指到誰）容易
  因為浮點誤差落在邊界上，變成畫面顯示 A、程式判定 B。

## 工作表欄位

程式會依下列標題列讀寫，**請勿更動欄位名稱與順序**（`setupSheets` 會自動建立）。

### Restaurants
| restaurantId | name | phone | note | active | menuImageUrl |
|---|---|---|---|---|---|
| 自動產生 | 餐廳名稱 | 電話 | 備註 | TRUE/FALSE | DM 原圖連結（辨識時自動填） |

> `menuImageUrl` 是後來才加的欄位。如果你的試算表是更早之前建的，
> 程式會在下次讀取時自動把這一欄補到標題列尾端，不用手動處理或重建。

### MenuItems
| itemId | restaurantId | name | price | category | available |
|---|---|---|---|---|---|
| 自動產生 | 對應餐廳 | 品項名稱 | 整數金額 | 分類（選填） | TRUE/FALSE |

### Sessions（一次揪團一列）
| sessionId | restaurantId | title | createdBy | createdAt | closeAt | status | rev |
|---|---|---|---|---|---|---|---|
| 自動產生 | 餐廳 | 標題 | 主揪 | 毫秒時間戳 | 毫秒時間戳 | open / closed | 版本號 |

### Orders（一人一列）
| orderId | sessionId | name | clientToken | itemsJson | total | note | createdAt | updatedAt | deleted |
|---|---|---|---|---|---|---|---|---|---|
| 自動產生 | 場次 | 姓名 | 裝置識別碼 | `[{name,price,qty,note}]` | 後端算出的總額 | 備註 | 毫秒 | 毫秒 | TRUE/FALSE |

菜單與品項可以直接在試算表裡編輯，也可以在 `lunch_admin.html` 的「餐廳菜單」分頁維護。

## API

前端一律透過 `lunch.js` 的 `gasGet()` / `gasPost()` 呼叫。

**GET**：`getBootstrap`、`getSession`、`poll`、`getRestaurants`、`getSummary`、`getHistory`、`ping`

**POST**（JSON body 帶 `action`）：`createSession`、`closeSession`、`extendSession`、
`submitOrder`、`updateOrder`、`deleteOrder`、`upsertRestaurant`、`upsertMenuItem`、`deleteMenuItem`、
`parseMenuImage`（辨識 DM，不寫試算表）、`applyParsedMenu`（把確認過的品項寫進去）

回傳格式：成功 `{status:'success', ...}`，失敗 `{status:'error', code, error}`。
常見錯誤碼：`CLOSED`（已停止收單）、`FORBIDDEN`（不是你的訂單）、`BUSY`（同時寫入衝突，請重試）、
`NO_API_KEY`（沒設 `GEMINI_API_KEY`）、`RATE_LIMIT`（額度用完）、`NO_ITEMS`（這張圖沒讀到品項）、
`NEED_AUTH`（Apps Script 授權不足）、`BAD_MODEL`（模型不存在）、`MODEL_BUSY`（模型壅塞，已重試過）。

## 幾個設計上的注意事項

- **POST 不要加 `Content-Type` header**。加了會觸發 CORS preflight，而 Apps Script 不回應 `OPTIONS`，
  請求會直接失敗。`lunch.js` 的 `gasPost()` 已經處理好，照用即可。
- **寫入都包在 `LockService` 裡**。GAS 沒有交易，多人同時送單時的 read-modify-write 會互相覆蓋，
  這是這類工具最常見的資料遺失來源。
- **截止時間由後端判定**。前端倒數只是體驗，`submitOrder` / `updateOrder` / `deleteOrder`
  都會再檢查一次場次狀態與 `closeAt`，逾時回 `CLOSED`。
- **所有回應都帶 `serverNow`**，前端用它算出時鐘偏移再跑倒數，同事電腦時間不準也不會有爭議。
- **金額一律用整數**，且 `total` 由後端依 `price × qty` 重算，不採用前端送來的數字。
- **刪除是軟刪除**（`deleted = TRUE`），資料留在試算表裡可供事後追查。
- **`parseMenuImage` 刻意不包在 `LockService` 裡**。它要跑十幾秒，佔著全域鎖會讓正在送單的
  同事全部卡住；它也不寫試算表，真正落地是使用者按下確認後的 `applyParsedMenu`。
- **辨識結果不被信任**。後端會再過濾一次空名稱、負數與超過上限的價格，前端還有一道人工確認。
- **讀取路徑一律不寫試算表**。`sessionOpen_` 只有在拿著鎖的寫入路徑才會把逾時的場次落地成
  `closed`。以前讀取路徑也會寫，於是場次截止的那一瞬間，所有人的輪詢同時對同一列發動沒有鎖
  保護的寫入——實際看過兩個 doGet 各卡 190 秒然後同時結束。狀態本來就是從 `closeAt` 算出來的，
  讀取根本不需要那個寫入。
- **前端一定要有逾時**。Apps Script 忙起來會把請求排隊，沒有逾時前端就真的乾等，使用者看到的
  是「載入中」轉好幾分鐘。放掉一個排隊中的請求沒有損失，下一輪就會補上。
- **只重試 5xx**。503「high demand」是 Google 端的瞬間壅塞，自動重試 3 次多半就過了；
  429 是額度問題，重試只會更糟，所以不retry。

## 疑難排解

| 看到的訊息 | 真正的原因 | 怎麼修 |
|---|---|---|
| 你沒有呼叫「UrlFetchApp.fetch」的權限 | 授權沒涵蓋新加的服務。請求根本沒送出去，**與額度或計費無關** | 執行 `authorizeAndSelfTest` 完成授權，再重新部署 |
| 指令碼還沒取得對外連線／Drive 的權限 | 同上（這是包裝過的訊息） | 同上 |
| 模型「…」不存在或你的金鑰無法使用 | 模型被 Google 汰換了 | 執行 `authorizeAndSelfTest` 看可用清單，設定指令碼屬性 `GEMINI_MODEL` |
| 還沒設定 GEMINI_API_KEY | 沒建立指令碼屬性 | 到「專案設定 → 指令碼屬性」新增 |
| GEMINI_API_KEY 無效或未啟用 | key 打錯，或該 Google 專案沒啟用 Generative Language API | 到 AI Studio 重新產生一組 |
| 辨識額度用完了 | 碰到免費方案的每分鐘／每日上限 | 等一下再試 |
| 模型「…」現在太忙（503） | Google 那端瞬間壅塞，**不是你的設定問題**。程式已自動重試 3 次 | 過幾分鐘再試；經常發生就換一個模型 |
| 執行 `authorizeAndSelfTest` 沒跳出同意畫面 | 多半是瀏覽器擋掉彈出視窗，或該次剛好沒觸發 | 允許 script.google.com 的彈出視窗，重新整理編輯器再執行一次 |
| 頁面轉很久才載入 / 執行紀錄出現數十秒以上的 doGet | 多個請求卡在同一個資源上互相等待 | 前端已加 20 秒逾時會自動放棄，不會再無限空轉 |
| 不支援的 action：parseMenuImage | 程式碼貼了但沒重新部署 | 部署 → 管理部署作業 → 編輯 → 版本選「新版本」 |
| 已套用品項，但原圖沒存成功 | 菜單有寫進去，只是 Drive 權限不足 | 執行 `authorizeAndSelfTest`；不修也不影響點餐 |
| 開單選了 A 餐廳，畫面卻顯示 B 餐廳 | 已經有一場在收單中，新的開單被擋下來了 | 執行 `diagnoseSessions` 看是哪一場擋住；先按「立即停止收單」再開新的 |

遇到任何辨識相關的問題，**第一件事都是執行 `authorizeAndSelfTest` 並看執行紀錄**，
它會直接指出是哪一環出問題。

場次相關的問題（開單被擋、顯示到錯的餐廳、看到舊的場次）則執行 **`diagnoseSessions`**。
它會列出所有餐廳與場次的原始值、後端實際挑中哪一場、以及現在按「開單」會不會被擋。
只讀資料，不會改到任何東西。

另外，每次按「開單」都會在執行紀錄留下 `[開單]` 開頭的紀錄，可以直接看到那一次
送出的 `restaurantId` 是哪一間、有沒有被擋、擋它的是第幾列。

## 常見問題

**Q: 開單時說「目前已有一場收單中」**
同時只允許一場，避免大家點到不同場。到主揪頁按「立即停止收單」，或等它自動截止。

**Q: 想改別人打錯的訂單**
主揪頁「目前訂單」表格可以直接刪除任一筆（帶 `isAdmin`），請對方重點一次。

**Q: 收單後還想補收**
主揪頁的「上一場」卡片有「重新開放 15 分鐘」。

**Q: 「已付」勾選為什麼別人看不到**
那是刻意只存在主揪自己的瀏覽器（localStorage），避免多人互相覆蓋收款狀態。

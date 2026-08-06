# 午餐訂單彙整系統 — 部署說明

這套工具跟飲料店那組（`admin.html` / `liff_order.html` / `ipad_dashboard.html`）**完全獨立**，
請另外開一個 Google 試算表與一個 Apps Script 專案，不要共用同一份 `GAS_URL`。

## 檔案

| 檔案 | 用途 |
|---|---|
| `lunch.html` | 同事點餐頁（手機優先） |
| `lunch_admin.html` | 主揪頁：開單、收單、彙整、菜單維護、歷史 |
| `lunch.js` | 兩頁共用的 API 與工具函式，`GAS_URL` 也在這裡 |
| `gas/lunch_Code.gs` | 後端程式碼，貼進 Apps Script 編輯器 |

## 部署步驟

1. **建立試算表**：到 Google 雲端硬碟新增一份試算表，命名例如「午餐訂單」。
2. **開啟 Apps Script**：在試算表選單點 `擴充功能 → Apps Script`。
3. **貼上程式碼**：把 `gas/lunch_Code.gs` 的全部內容貼進 `Code.gs`（覆蓋原本的內容），存檔。
4. **初始化工作表**：在編輯器上方的函式下拉選單選 `setupSheets`，按執行。
   第一次會要求授權，同意即可。執行完會自動建好四張工作表與一間範例餐廳。
5. **部署為網頁應用程式**：點右上角 `部署 → 新增部署作業`，類型選「網頁應用程式」，
   - 執行身分：**我**
   - 具有存取權的使用者：**任何人**（同事不用登入 Google 才點得到）
6. **複製網址**：部署後會給一段 `https://script.google.com/macros/s/AKfy.../exec`，
   把它貼進 `lunch.js` 第 8 行的 `GAS_URL`。
7. 把 `lunch.html` / `lunch_admin.html` / `lunch.js` 一起放上網站（推上 `main`，Vercel 會自動部署）。
8. **（選用）啟用菜單 DM 辨識** —— 見下一節。

> **改過程式碼要重新部署**：Apps Script 每次改完要點 `部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署`，
> 網址不會變。若選「新增部署作業」則會產生新網址，`lunch.js` 也要跟著換。

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

### 額度與限制

免費方案有每分鐘／每日的請求上限。以「偶爾傳一張菜單」的用量來說遠遠夠用，
真的碰到上限時後端會回「今天的免費辨識額度用完了」，隔天就恢復。

模型設定在 `lunch_Code.gs` 最上面的 `GEMINI_MODEL`（預設 `gemini-2.5-flash`）。
Google 免費方案的資料可能被用於改善其產品；傳的是餐廳 DM，通常不成問題，但還是先知道為好。

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
`NO_API_KEY`（沒設 `GEMINI_API_KEY`）、`RATE_LIMIT`（免費額度用完）、`NO_ITEMS`（這張圖沒讀到品項）。

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

## 常見問題

**Q: 開單時說「目前已有一場收單中」**
同時只允許一場，避免大家點到不同場。到主揪頁按「立即停止收單」，或等它自動截止。

**Q: 想改別人打錯的訂單**
主揪頁「目前訂單」表格可以直接刪除任一筆（帶 `isAdmin`），請對方重點一次。

**Q: 收單後還想補收**
主揪頁的「上一場」卡片有「重新開放 15 分鐘」。

**Q: 「已付」勾選為什麼別人看不到**
那是刻意只存在主揪自己的瀏覽器（localStorage），避免多人互相覆蓋收款狀態。

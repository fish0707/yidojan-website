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
7. 把 `lunch.html` / `lunch_admin.html` / `lunch.js` 一起放上網站（GitHub Pages 直接推 repo 即可）。

> **改過程式碼要重新部署**：Apps Script 每次改完要點 `部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署`，
> 網址不會變。若選「新增部署作業」則會產生新網址，`lunch.js` 也要跟著換。

## 工作表欄位

程式會依下列標題列讀寫，**請勿更動欄位名稱與順序**（`setupSheets` 會自動建立）。

### Restaurants
| restaurantId | name | phone | note | active |
|---|---|---|---|---|
| 自動產生 | 餐廳名稱 | 電話 | 備註 | TRUE/FALSE |

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
`submitOrder`、`updateOrder`、`deleteOrder`、`upsertRestaurant`、`upsertMenuItem`、`deleteMenuItem`

回傳格式：成功 `{status:'success', ...}`，失敗 `{status:'error', code, error}`。
常見錯誤碼：`CLOSED`（已停止收單）、`FORBIDDEN`（不是你的訂單）、`BUSY`（同時寫入衝突，請重試）。

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

## 常見問題

**Q: 開單時說「目前已有一場收單中」**
同時只允許一場，避免大家點到不同場。到主揪頁按「立即停止收單」，或等它自動截止。

**Q: 想改別人打錯的訂單**
主揪頁「目前訂單」表格可以直接刪除任一筆（帶 `isAdmin`），請對方重點一次。

**Q: 收單後還想補收**
主揪頁的「上一場」卡片有「重新開放 15 分鐘」。

**Q: 「已付」勾選為什麼別人看不到**
那是刻意只存在主揪自己的瀏覽器（localStorage），避免多人互相覆蓋收款狀態。

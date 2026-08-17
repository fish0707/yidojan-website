# 盤中即時報價代理（Cloudflare Worker）— 部署說明

## 為什麼要換掉 Google Apps Script

你部署的 GAS 代理盤中一直出現「連線失敗：無法開啟網址」。這不是設定錯，是**證交所擋掉了
Google Apps Script 的 IP**。

這個結論是實測出來的，不是猜的。我從 GitHub 的伺服器打同一支 API：

| 測試 | 結果 |
|---|---|
| 完全不帶任何標頭、查一檔 | ✅ HTTP 200，拿到真實報價 |
| 查十二檔、管線符號編碼成 `%7C`（**跟 GAS 一模一樣的寫法**） | ✅ HTTP 200 |
| 每 3 秒連打 6 次 | ✅ 全部 200，沒有被限流 |

所以證交所擋的不是「機器人」、不是「資料中心 IP」、也不是請求寫法——GAS 那邊怎麼改都沒用，
**換一個出口 IP 才是解法**。

同一次實測也確認：這支 API 的回應**沒有 CORS 標頭**，所以瀏覽器不能直接抓，代理層是必要的。

Cloudflare Worker 的 IP 池跟 Google 完全不同，而且免費額度是每天 10 萬次請求——
盤中每 10 秒一次、一天約 1,600 次，用不到 2%。

## 部署步驟（約兩分鐘）

1. 到 [dash.cloudflare.com](https://dash.cloudflare.com) 註冊或登入（免費方案就夠）。
2. 左側選 **Workers & Pages** → **Create** → **Start with Hello World!** → **Deploy**。
   先讓它用預設程式碼部署一次，拿到一個網址。
3. 部署完點 **Edit code**，把編輯器裡的內容<b>全部刪掉</b>，貼上 `cloudflare/quote-worker.js`
   的完整內容，右上角按 **Deploy**。
4. 複製你的 Worker 網址，長得像：
   `https://你取的名字.你的帳號.workers.dev`
5. 回到 `daytrade.html`，把這個網址貼進「盤中即時監控」的即時報價網址欄位
   （原本填 GAS 網址的那一格，直接換掉就好）。

## 確認有沒有成功

部署完直接在瀏覽器打開這個網址：

```
https://你的網址.workers.dev/?action=diag
```

看到 `"summary": "Worker 連得到證交所即時報價，可以正常使用"` 就成功了。

也可以直接查報價確認：

```
https://你的網址.workers.dev/?action=quote&codes=2330
```

## 介面跟 GAS 版完全相同

回傳的 JSON 格式一模一樣，所以網頁那邊**除了換網址什麼都不用改**，
兩邊也可以隨時換回去。

| 用途 | 網址 |
|---|---|
| 查報價 | `?action=quote&codes=tse_2330,tse_2317`（不帶 `tse_`／`otc_` 前綴會自動補上市） |
| 連線診斷 | `?action=diag` |
| 存活確認 | `?action=ping` |

## 已知限制

- 這支 API 只回「當下快照」（最新成交價、當日累計高低），不是逐筆 K 線。
  網頁是用反覆輪詢的快照自己堆出近似的 15 分鐘蠟燭——兩次輪詢之間的瞬間插針可能沒被捕捉到。
- 非交易時間查得到，但成交價會是空的（`price: null`），這是正常現象不是故障。
- Worker 內建 3 秒快取，多開幾個分頁也不會等比例增加對證交所的請求。

## GAS 版還留著嗎

留著。`gas/daytrade_quote/` 沒有刪除，如果哪天證交所解除對 Google 的封鎖，
那條路可以直接切回去用——兩邊介面相同，換網址即可。
GAS 版也內建了 `diagnoseQuoteSources()`，可以隨時在 Apps Script 編輯器執行確認現況。

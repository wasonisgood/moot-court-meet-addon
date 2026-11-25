# Moot Court Timer — Google Meet Add-on

法庭模擬計時器，以 **Google Meet 附加元件（Meet add-on）** 形式運作：Meet 會在側邊面板（side panel）以 iframe 載入本頁面。
這是 Workspace 附加元件，不是 Chrome 擴充功能；舊的 Chrome 擴充功能版本保留在 `../meet-extension/`。

## 功能

- 檢方、辯方各自 **40 分鐘總時長**，段落計時時自動扣減，可單獨重設
- 三個段落（法庭一、法庭二、反駁），時長可自訂並存在瀏覽器本機
- 剩餘 **5 分鐘 / 1 分鐘** 以英文語音與提示音提醒，時間到自動結束
- 可選擇錄製麥克風，結束時下載錄音檔（見下方限制）

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `index.html` | 側邊面板頁面（樣式內嵌，載入 Meet Add-ons SDK） |
| `app.js` | 計時邏輯、SDK 初始化、麥克風錄音 |
| `manifest.json` | 部署用的附加元件清單範本（HTTP 部署時貼到 Cloud console） |

沒有建置步驟，純 HTML／JS，任何 HTTPS 靜態主機都可以。

## 部署步驟

依照官方指南（[快速入門](https://developers.google.com/workspace/meet/add-ons/guides/quickstart?hl=zh-tw)、部署指南）：

1. **把檔案放到 HTTPS 網站**：例如 GitHub Pages 或 Firebase Hosting，確認能開啟 `https://你的網址/meet-addon/index.html`。
2. **建立 Google Cloud 專案**，記下「專案編號」（Project number）。
3. **啟用 API**：在 Cloud console 啟用「Google Workspace Marketplace SDK」與「Google Workspace Add-ons API」。注意不要啟用名稱相近的「Google Workspace Marketplace API」。
4. **設定 `app.js`**：把 `CLOUD_PROJECT_NUMBER` 換成第 2 步的專案編號。
5. **設定 `manifest.json`**：把所有 `YOUR-HOST` 換成你的網域，並準備 `logo.png`。
6. **建立部署**：Marketplace SDK 頁面 → 「HTTP deployments」→「Create new deployment」，貼上清單 JSON；在「App configuration」選擇「Google Workspace add-on」與「Deploy using cloud deployment resource」。
7. **安裝測試**：在「HTTP deployments」點該部署的「Install」（以目前登入的帳號安裝）。
8. **在 Meet 中使用**：開啟 meet.google.com 開會，點會議工具（活動面板）中的此附加元件即可。

> 上述清單欄位與步驟來自官方文件摘要；正式部署前請對照最新的部署指南確認欄位名稱。

## 限制（請先閱讀）

- **無法錄到其他參與者的聲音。** 附加元件 SDK 目前文件中只提到畫面共享（`supportsScreenSharing`），沒有提供會議音訊或分頁音訊的存取。因此這個版本只能錄你自己的麥克風。
- 若要錄會議中所有人的發言，需要改用其他方式（例如 Meet 本身的錄影／逐字稿功能，或另外的媒體 API），這些都不在本附加元件的範圍內。
- 麥克風錄音是在 iframe 中用 `getUserMedia` 取得的，Meet 是否允許此 iframe 使用麥克風**尚未實測**；若不允許，程式會顯示「無法錄音，僅計時」並照常計時。
- 段落進行中若關閉側邊面板，計時與錄音都會中斷。
- 時長與雙方剩餘時間存在 `localStorage`，同一瀏覽器內保留；換裝置不會同步。
- 尚未在真實 Meet 會議中測試。只做過 JavaScript 語法檢查與清單 JSON 格式檢查。

## 本機預覽

直接用瀏覽器開啟 `index.html` 即可測試計時功能；頁面上會出現「目前不在 Google Meet 中」的提示，這是正常的。

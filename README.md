# Moot Court Timer — Google Meet Add-on

法庭模擬計時器，以 **Google Meet 附加元件** 形式運作。側邊面板負責控制，主舞台負責大畫面顯示；主持人開始共享後，所有參與者會同步看到計時，並在 5 分鐘、1 分鐘與時間到時聽到英文語音提醒。

- 線上位置：`https://wasonisgood.github.io/moot-court-meet-addon/`
- Cloud 專案：`moot-court-meet-2026`（專案編號 `1070073783084`）
- 同步後端：Firestore（同一專案）

## 功能

- 檢方、辯方各自 **40 分鐘總時長**，段落計時時自動扣減，可單獨重設
- 三個段落（法庭一、法庭二、反駁），時長可自訂並存在瀏覽器本機
- **共享計時**：主持人按「開始共享計時」後，主舞台與所有參與者的面板同步顯示剩餘時間與雙方時長
- **共享提醒**：剩 5 分鐘、1 分鐘與時間到時，每位參與者的畫面會顯示提醒並播放英文語音；提醒畫面 **20 秒後自動隱藏**
- 主持人可選擇錄製自己的麥克風（預設關閉）；結束時下載錄音檔

## 參與者需要做什麼

什麼都不用設定。主持人開始共享後，參與者會收到「加入活動」的提示；若還沒安裝附加元件，依提示安裝即可。參與者的面板為唯讀，只顯示共享狀態。

## 運作方式

```
主持人側邊面板 ──寫入── Firestore rooms/{房間ID} ──即時訂閱──┬── 參與者側邊面板（唯讀、播放聲音）
                                                            └── 主舞台（大畫面、播放聲音）
```

- 房間 ID 是隨機 UUID，由主持人產生，放在 Meet 活動的啟動資料（`additionalData`）中，只有參與該活動的人會拿到。
- 聲音只會在每位參與者的裝置播放，不會經過 Meet 音訊，所以主持人不需要開麥。
- 同一位參與者的側邊面板與主舞台共用 `localStorage`，用 `seq` 去重，確保同一提醒只播放一次。

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `index.html` | 側邊面板（主持人控制、參與者唯讀） |
| `mainstage.html` | 主舞台大畫面（`?room=` 參數帶入房間 ID） |
| `app.js` | 計時邏輯、共享狀態發布與模式切換 |
| `sync.js` | Firestore 發布／訂閱、聲音去重、語音與提示音 |
| `manifest.json` | 附加元件清單（部署時使用） |
| `firestore.rules` | Firestore 安全規則 |
| `firebase.json`、`.firebaserc` | Firebase CLI 設定（僅部署規則用） |

## 更新部署

1. 修改程式後提交並推送到 `main`，GitHub Pages 會自動更新（約 1 分鐘）。
2. 只改前端程式時，不需要重新安裝附加元件。
3. 修改 `manifest.json` 的欄位時，需要重新執行：
   ```
   gcloud workspace-add-ons deployments replace moot-court-timer --deployment-file=manifest.json --project=moot-court-meet-2026
   ```
4. 修改 `firestore.rules` 時：`firebase deploy --only firestore:rules --project moot-court-meet-2026`

## 安全性與限制

- **Firestore 規則沒有登入機制**：任何知道房間 ID（36 字元 UUID）的人都能讀寫該房間。房間 ID 只存在於 Meet 活動的啟動資料中，外人無法得知，但這不是嚴格的身分驗證。規則同時限制欄位名稱與長度，且禁止刪除。
- 房間資料會留在 Firestore 中，目前沒有自動清除機制。
- 主舞台能否由程式關閉，官方文件沒有說明；本實作只讓提醒畫面 20 秒後自動隱藏，主舞台本身不會被關閉。
- 每位參與者的聲音由各自裝置播放，音量取決於該裝置；若參與者靜音或使用耳機，聽不到提醒，畫面提醒仍會顯示。
- 活動中途重新整理側邊面板的主持人，會變成唯讀參與者，需要重新開始共享。
- 尚未在真實 Meet 會議中，以多人測試過聲音去重與主舞台顯示。

## 本機預覽

直接開啟 `index.html` 或 `mainstage.html?room=測試` 可測試畫面，但共享功能需要在 Meet 中才會啟動。

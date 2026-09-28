# LINE 店家串接清單

本機程式已備妥，實際 channel、帳號、網域與正式活動資料尚未配置。先接一間店做實機測試，通過後依同樣步驟逐店啟用。

## 主辦方一次性設定

1. 決定 HTTPS 網域與 Node.js 24+ 持久磁碟主機。
2. 確認主官方帳號、Messaging API channel 及 Provider。
3. 在同一 Provider 建立主 LINE Login channel，連結主官方帳號。
4. 新增主 LIFF：Endpoint 為 `https://YOUR_DOMAIN/`，Size 為 Full，Scopes 為 `openid`、`profile`。
5. 設定伺服器 LIFF_ID、LINE_LOGIN_CHANNEL_ID、MAIN_OA_ID、APP_ORIGIN。

## 每家店需要的資料與設定

| 資料 | 例子 | 放置位置 |
| --- | --- | --- |
| 固定店家 ID | store-001 | 活動設定及入口參數 |
| 店名、故事、分類、地址 | 正式店家資料 | config/campaign.json |
| LINE 官方帳號 ID | @實際ID | 店家 officialAccountId |
| 店家 Login Channel ID | 數字 ID | 伺服器 MERCHANT_LINE_LOGINS_JSON |
| 店家 Login Channel Secret | 私密值 | 僅伺服器環境設定，不貼在聊天或公開文件 |
| 店員工作金鑰 | 長隨機字串 | 安全提供店員，伺服器只存 SHA256 |

店家的官方帳號需要启用 Messaging API。店家 Login channel 必須在該 Messaging API channel 的同一 Provider 之下，並將 Linked LINE Official Account 指向該店。不要為了本活動搬動或重建既有帳號。

若已有 LINE Login channel，先確認是否有其他應用依賴既有 Linked LINE Official Account；不要直接覆蓋其他服務設定。可以在正確的 Provider 下另建專用 Login channel，保留原有服務。

每店 Login channel 的 Web app Callback URL 加入：

```text
https://YOUR_DOMAIN/auth/merchant/callback
```

正式使用前依 LINE Console 的 channel 狀態與權限完成發布／測試帳號設定；開發中 channel 不代表所有民眾都有權使用。

## 圖文選單設定

按鈕名稱建議「和美探店集章」，動作選「連結」：

```text
https://liff.line.me/主LIFF_ID?shop=store-001
```

工作台會產生該店專屬入口，所有店家均使用同一個主 LIFF ID。不要把短效環保加分碼放進圖文選單。

## 第一間店的手機驗收

- iOS LINE、Android LINE：第一次登入與已授權使用者皆可返回主集章冊。
- 已加入店家好友：直接驗證成功，一枚章入帳。
- 尚未加入／已封鎖：不發章；完成加入／解除封鎖後重新確認能發章。
- 取消授權／逾時／換瀏覽器：不誤发章，有重試提示。
- 重複按入口：原章保留，不新增第二枚。
- 使用不同 Provider 的店家帳號：正確綁定主會員，不將兩個不同 user ID 直接當相同。
- 環保杯與 MOOVO：店員核准後掃碼加分；換店重複同項任務不超每日上限。
- 兌換：只有指定店可核銷，重複核銷被拒絕。

## 正式活動資料

仍需主辦決定正式店家名單、活動起訖時間、每項分數與次數、獎勵門檻與庫存。預览暫用每店一章、環保杯和 MOOVO 各每日一次加一分；都可在設定檔修改。

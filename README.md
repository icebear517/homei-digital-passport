# 數位和美幫 · LINE 集章護照

一個主辦 LIFF、同一本集章冊。民眾從店家官方帳號的按鈕進入，系統啟動該店好友驗證，確認成功就自動發章。自備環保杯與 MOOVO 騎乘則由店員確認、核發一次性環保加分碼。

目前是可執行的本機預覽與正式串接程式，**尚未接入真實 LINE 帳號、MOOVO API 或部署**。本機模擬和正式好友驗證有不同 API；正式環境不提供模擬發章。三家店名、獎勵、點數與上限都是示範值，並非正式活動辦法。

## 啟動與預覽

需要 Node.js 24+，資料庫使用 Node 內建 SQLite。

```sh
npm ci
npm start
```

- 會員：http://localhost:3000
- 示範店家入口：http://localhost:3000/?shop=sample-cafe
- 店家工作台：http://localhost:3000/staff
- 示範店家金鑰：`demo-staff`。本機所有訪客共用一位示範會員。
- 資料保存在 `data/passport.sqlite`，重新整理或重開服務不會消失。
- `npm run check` 檢查語法；`npm test` 執行 API 整合測試，LINE 回應用測試替身，不連線真實 LINE。

本機操作：

1. 打開示範店家入口，選「模擬：尚未加入好友」，確認不發章；再驗證並選「模擬：已加入好友」，取得一枚章。
2. 到工作台登入，勾選已完成的環保杯／MOOVO，產生加分碼。點該碼下的本機示範連結，確認領取環保分。
3. 在探索店家頁取得三間店的示範好友章。好禮頁可產生兌換碼，由「街角咖啡」工作台查詢與確認核銷。

## 目前規則

| 項目 | 預覽設定 |
| --- | --- |
| 店家好友章 | 新舊好友皆可；每活動／會員／店家一次，驗證時須已加好友且未封鎖 |
| 環保杯 | 店員確認本次使用自備杯；每人每日一次，+1 分 |
| MOOVO | 店員查看本人當日騎乘紀錄；每人每日一次，+1 分 |
| 每日上限 | 以 Asia/Taipei 日期計算，所有店家合計 |
| 一次性環保碼 | 2 分鐘有效，同一枚可包含兩種環保任務；其中一項已達上限時，只發其他尚可取得的分數 |
| 一般示範獎勵 | 3 枚店家章解鎖 |
| 環保示範獎勵 | 3 枚店家章及 2 分環保分解鎖 |
| 兌換 | 5 分鐘兌換碼，指定店員核銷；每獎勵每人一次，受庫存限制，不扣章或環保分 |

活動資料與規則在 `config/campaign.json`。沒有保存騎乘截圖，也沒有自動取得 MOOVO 個人騎乘紀錄。環保任務目前每家工作台都可核發，店員必須實際看到任務完成。

## 店家好友驗證

店家圖文選單連結格式：

```text
https://liff.line.me/{主LIFF_ID}?shop={店家ID}
```

網址中的 `shop` 只選擇驗證哪間店；帶入 `friend=true`、`userId` 或自行修改店家代碼都不會直接發章。也相容舊的 `source` 入口參數。

實作順序：

1. 主 LIFF 登入，後端驗證主 channel 的 LINE ID token、access token 及使用者一致性，建立會員 session。
2. 後端依店家 ID 找到該店 LINE Login 設定，產生限時 OAuth state、nonce 和 PKCE。state 同時綁定發起的會員、店家與瀏覽器 session。
3. 瀏覽器進入該店的 LINE Login 授權。首次可能需要同意授權；不是保證每次零額外操作。
4. LINE 返回固定 callback。後端消耗一次性 state，交換 token，驗證 channel／nonce／期限／使用者一致性，再用店家 access token 查詢好友資格。
5. 僅當 LINE 明確回傳 `friendFlag === true` 才發章。店家身分只可綁定一個主集章會員，避免跨會員重複使用同一好友身分。
6. 返回同一集章網站，仍以原本主 LIFF 初始化。取消授權、非好友、逾時或錯誤皆不發章；畫面提供重試或加入店家入口。

不同 Provider 的 LINE user ID 不相同。系統記錄經登入流程綁定的主會員與店家身分，不直接假設兩個 ID 相等。

## LINE 設定

完整逐店操作見 [LINE 店家串接清單](docs/LINE店家串接清單.md)。沒有設定驗證的店家會顯示「尚未啟用好友驗證」。

主辦方：在自己的 Provider 下設定主 LINE Login channel、Full 畫面 LIFF，啟用 `openid profile`，Endpoint 指向網站 HTTPS 根網址。主 Login channel 連結主官方帳號。

每間店：需要一個 LINE Login channel，與該店官方帳號的 Messaging API channel 在同一 Provider，並將 **Linked LINE Official Account 設為該店帳號**。只需設定店家 Login，不需要再開另一個集章 LIFF，也不需要更換既有 Messaging API webhook。

各店 LINE Login 註冊相同 callback：

```text
https://YOUR_DOMAIN/auth/merchant/callback
```

依 `.env.example` 在伺服器安全設定：

```text
APP_MODE=production
APP_ORIGIN=https://YOUR_DOMAIN
LIFF_ID=主LIFF_ID
LINE_LOGIN_CHANNEL_ID=主LoginChannelID
MAIN_OA_ID=@主官方帳號ID
MERCHANT_LINE_LOGINS_JSON={"store-001":{"channelId":"店家LoginChannelID","channelSecret":"僅存伺服器的Secret"}}
STAFF_CREDENTIALS_JSON={"store-001":"該店長隨機工作金鑰的SHA256雜湊"}
```

`config/campaign.json` 的各店 `officialAccountId` 放正式 `@ID`，JSON key 必須與店家 `id` 一致。Secret 和工作金鑰不放前端、不貼圖文選單、不提交版本控制。公開 `/api/config` 只提供是否已配置好友驗證，不提供 secret。

## 正式啟用前剩餘工作

- 換成正式店家清單、官方帳號 ID、活動日期、獎勵及庫存、主辦資料聯絡方式；所有 `sample` 設為 false。正式模式會拒絕示範活動、缺失的主 LINE 設定、錯誤活動日期與無效店家金鑰設定。
- 挑一間真實店家做 iOS／Android LINE 實機測試：新舊好友、封鎖、取消授權及跨 Provider 綁定。現有自動測試不能證明 LINE App 內的 OAuth 導航／cookie 保存一定可用；若離開原瀏覽器 session，系統會拒絕發章並要求重試，不以不可信參數繞過驗證。
- 逐店人工核对 Login channel 實際綁定帳號與設定中的 `officialAccountId` 一致；好友 API 回應不包含可用來核對店家的 OA ID。
- 部署至具備 HTTPS 與持久磁碟的 Node 服務。APP_ORIGIN 不含尾端 `/`；反向代理保留 Origin。預覽模式只綁 localhost。SQLite 與本機限流適用單服務實例，不適用純靜態 hosting 或多主機共用檔案。
- 為每店產生獨立長隨機工作金鑰；會員／店家 session 為 2 小時。金鑰輪替後，既有 session 仍會到期才失效；需要即時撤銷時應由維運清除該店 session。
- 確認公開活動辦法與會員資料保存／刪除流程。此版沒有管理後台、行銷推播、成效匯出或 MOOVO 官方合作串接。

不要在運行中單獨複製 SQLite 主檔作備份（可能有 WAL）；使用 SQLite backup 功能，或停機後備份資料目錄。不要把 demo 資料庫作正式活動資料庫。

## 主要檔案

- `server/app.js`：LINE 驗證、會員／店家權限、交易、集章、環保分與兌換。
- `server/index.js`：服務啟動及環境設定。
- `public/app.js`：民眾集章冊、店家、環保任務與好禮。
- `public/staff.js`：店家入口、環保核發及核銷。
- `test/app.test.js`：驗證、重複領取、跨店每日限制、日期切換及兌換測試。

## 技術依據

- [LIFF 在伺服器驗證身分](https://developers.line.biz/en/docs/liff/using-user-profile/)
- [LINE Login OAuth 流程](https://developers.line.biz/en/docs/line-login/integrate-line-login/)
- [PKCE](https://developers.line.biz/en/docs/line-login/integrate-pkce/)
- [綁定官方帳號](https://developers.line.biz/en/docs/line-login/link-a-bot/)
- [好友狀態 API](https://developers.line.biz/en/reference/line-login/#friendship-status)

一般 LIFF 的 getFriendship 只查自己綁定的官方帳號；因此本系統透過各店 Login channel 在後端查證。臺灣活動不依賴日本限定的 MINI App 多帳號功能。

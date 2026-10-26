# 數位和美幫數位集章活動

LINE LIFF 集章、幸運轉盤、數位券與店家核銷系統。

## 正式流程

1. 店內 QR 導到店家 LINE OA 並預填「參加數位集章活動」；沒有 LINE OA 的店家則直接開啟 Facebook 任務頁。
2. 店家的自動回應貼入專屬 LIFF 連結。民眾在店家頁按「確認並蓋章」後才收下一枚章。
3. 每 3 間不同店家增加 1 次轉盤機會；券碼由店員登入 `/staff` 後一次性核銷。

店家清單僅提供 Google Maps 導航；集章 API 必須帶有由伺服器簽署的店內 QR entry token，因此手動輸入店家代號無法蓋章。

## 本機展示

```sh
npm install
npm start
```

開啟 <http://localhost:3000/>；店員核銷頁是 <http://localhost:3000/staff>。展示工作碼：`demo-staff`。

```sh
npm test
npm run check
```

## Coolify 正式環境

1. 在 Coolify 建立 PostgreSQL，將它的內部連線字串設定為 `DATABASE_URL`。
2. 使用本專案的 `Dockerfile` 部署，綁定 `passport.rainbowhouse.tw`；DNS 指向 Coolify 後即可取得 HTTPS。
3. 設定下列 Coolify Secrets：

```text
APP_MODE=production
HOST=0.0.0.0
PORT=3000
APP_ORIGIN=https://passport.rainbowhouse.tw
DATABASE_URL=<Coolify PostgreSQL internal URL>
LIFF_ID=<main LIFF ID>
STAFF_LIFF_ID=<optional staff LIFF ID>
LINE_LOGIN_CHANNEL_ID=<the LIFF channel ID>
ENTRY_SIGNING_SECRET=<long random secret>
GOOGLE_SHEET_ID=1yVYi_vSx9F-2J9fEpWJnMEQuuRGNHUTn5YSH36AvGFA
GOOGLE_SERVICE_ACCOUNT_JSON=<one-line service account JSON>
STAFF_CREDENTIALS_JSON=<merchant-id to SHA-256 work-code hash map>
```

4. 將 Google Sheet 分享給服務帳號 Email，權限只需要「檢視者」。系統啟動及每五分鐘讀取「店家上架管理」與「獎品上架管理」；只有「上架狀態」為 `上架` 的列會公開。
5. 每位店家用 `/staff` 登入，下載店內 QR 並複製自動回應的 LIFF 連結。LINE OA 店家要填 `LINE @ID`，Facebook 店家要填粉專網址與任務方式 `FACEBOOK`。

不要把工作碼明碼、Google 服務帳號 JSON、資料庫密碼或 LINE Channel Secret 放進 Git。

# 实时同传对话（Cloudflare）

1 对 1 实时字幕同传。两人各说各的语言，对方实时看到 **自己语言** 的字幕；说话人本地也能看见模型对自己这句话的译文，方便核对。

当前部署模式：**受邀访问**。

- 整站一道密码（`SITE_PASSWORD`）：知道的人才能进入。
- 进入后任意创建房间，房间号 + 房间密码就是发给对方的"子凭证"。
- 每位说话人单次最多 **1 分钟**（`TRIAL_SECONDS`，可改）。

账户 / 邮件登录 / Google / 微信 / 兑换码 这些代码留在仓库里但 UI 已隐藏，等以后正式收费时再启用。

## 架构

```
[Browser]  ── WSS ──>  [Cloudflare Worker + Durable Object]
                              │
                              └── WSS ──> api.openai.com (Authorization: 运营方 key)
```

- 浏览器不直连 OpenAI，全部走 Cloudflare 反代 ⇒ **大陆免 VPN**（绑自定义域名更稳）。
- 音频在浏览器用 AudioWorklet 抓 PCM16 @ 24 kHz，base64 通过 WS 上行。
- OpenAI key 由你（运营方）放在 Worker secret 里，前端永远拿不到。

## 部署到 Cloudflare（首次）

```bash
npm install
npx wrangler login

# 创建 D1（账户/兑换码代码暂不启用，但 schema 已存在，先建好以后好用）
npm run db:create                # 把返回的 database_id 粘到 wrangler.toml
npm run db:migrate

# 必填 secrets
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SITE_PASSWORD     # 你给受邀用户的访问密码

npm run deploy
```

部署后会得到 `https://realtime-interp.<你子域>.workers.dev`。

第一次访问会跳到 `/site-auth`，输入 `SITE_PASSWORD` 即可进入。后续 30 天内有 cookie 不再询问。点击右上角 "退出" 可解除。

## 本地开发

```bash
npm install
npm run db:migrate:local
npm run dev
# http://localhost:8787
```

`.dev.vars`（已 gitignore）里默认放了 `SITE_PASSWORD = "tongchuan-7K9M"`，本地直接用这个进入；生产请另起一个。

## 邀请新人使用

1. 把站点 URL + `SITE_PASSWORD` 一起发给对方（或者你帮他打开后留着 cookie）。
2. 进入后任一人点"创建房间"，会得到房间号；可选填房间密码作为加房间的二次凭证。
3. 把 **房间号** 和 **房间密码** 发给对方，对方点"加入房间"输入即可。

## 调整时长 / 改密码

- 时长：改 `wrangler.toml` 里 `TRIAL_SECONDS`（秒），重新 `npm run deploy`。
- 站点密码：在 Cloudflare Dashboard → Workers → Settings → Variables → Secret 里改 `SITE_PASSWORD`，所有人下次需要重新输入。

## 还未启用（代码已就位）

`src/auth.js`、`src/codes.js`、`src/db.js`、`migrations/0001_init.sql`、`scripts/gen-codes.mjs` 以及 `/api/me`、`/api/redeem`、`/auth/*` 路由都还在，未来要打开账户/付费时把 UI 重新挂回来即可。

## 文件结构

```
trans/
├── wrangler.toml
├── package.json
├── migrations/0001_init.sql       # D1 schema（未来用）
├── scripts/gen-codes.mjs          # 兑换码 CLI（未来用）
├── src/
│   ├── index.js                   # Worker 入口：站点门禁 + HTTP/WS 路由
│   ├── room.js                    # Durable Object：信令 + OpenAI 反代
│   ├── auth.js                    # 邮箱/Google/微信 登录（休眠）
│   ├── codes.js                   # 兑换码兑换（休眠）
│   └── db.js                      # D1 helpers（休眠）
└── public/
    ├── index.html                 # SPA: home / create / join / room（login/account 视图暂不挂导航）
    ├── styles.css
    ├── app.js
    └── pcm-worklet.js
```

## 安全提示

- `OPENAI_API_KEY` 与 `SITE_PASSWORD` 都只在 Worker 进程内存；客户端、git、日志都看不到。
- 站点密码用 SHA-256 哈希后写在 cookie 里，泄露 cookie ≠ 泄露密码本身。
- `.dev.vars` 已 gitignore，本地测试 key 不进版本控制。

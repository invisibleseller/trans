# 实时同传对话（Cloudflare）

1 对 1 实时字幕同传。两人各说各的语言，对方实时看到 **自己语言** 的字幕。说话人本地也能看见模型对自己这句话的译文，方便核对。账户系统支持邮箱魔法链接 / Google / 微信 登录，用兑换码充值时长。

## 关键设计

```
[Browser]  ── WSS ──>  [Cloudflare Worker + Durable Object + D1]
                              │
                              └── WSS ──> api.openai.com (Authorization: 运营方 key)
```

- 浏览器不直连 OpenAI，全部走 Cloudflare 反代 ⇒ **大陆免 VPN**（绑自定义域名更稳）。
- 音频在浏览器用 AudioWorklet 抓 PCM16 @ 24 kHz，base64 通过 WS 上行。
- OpenAI key 由你（运营方）放在 Worker secret 里，前端永远拿不到。
- 服务端按音频字节计费：登录用户扣余额，匿名用户用 30 秒试用配额。
- 账户、会话、兑换码、用量流水：Cloudflare D1（免费档 SQLite 足够）。

## 部署到 Cloudflare（首次）

```bash
npm install
npx wrangler login

# 1. 创建 D1 数据库，把返回的 database_id 粘到 wrangler.toml
npm run db:create

# 2. 应用表结构
npm run db:migrate

# 3. 配置 secrets（按需）
npx wrangler secret put OPENAI_API_KEY              # 必填
npx wrangler secret put RESEND_API_KEY              # 可选，发邮件用
npx wrangler secret put GOOGLE_CLIENT_ID            # 可选
npx wrangler secret put GOOGLE_CLIENT_SECRET        # 可选
npx wrangler secret put WECHAT_APP_ID               # 可选（需开放平台资质）
npx wrangler secret put WECHAT_APP_SECRET           # 可选

# 4. 部署
npm run deploy
```

部署后会得到 `https://realtime-interp.<你子域>.workers.dev`。

**绑定自定义域名**（推荐，国内连通性更稳）：
Cloudflare Dashboard → Workers → 你的 Worker → Triggers → Custom Domains。

## 本地开发

```bash
npm install
npm run db:migrate:local
npm run dev
# http://localhost:8787
```

本地把 secrets 写在 `.dev.vars`（仓库已 gitignore）：

```ini
OPENAI_API_KEY = "sk-..."
# RESEND_API_KEY = "re_..."
# EMAIL_FROM = "noreply@yourdomain.com"
# GOOGLE_CLIENT_ID = ""
# GOOGLE_CLIENT_SECRET = ""
```

没配 `RESEND_API_KEY` 时，魔法链接会打印到 `wrangler tail` / dev 控制台，方便本地调试。

## 生成兑换码（运营方用）

```bash
# 10 张 30 分钟（¥88 档）兑换码
node scripts/gen-codes.mjs --minutes 30 --count 10 --label "30min ¥88"

# 加 --local 写入本地 D1
node scripts/gen-codes.mjs --minutes 5 --count 3 --label "5min ¥18" --local
```

脚本会在 D1 `redemption_codes` 表插入并打印出码，分发给付款用户即可。

## 推荐定价

按音频输入分钟（OpenAI gpt-4o-realtime 现行价 ≈ ¥1.4–1.6/min 成本）：

| 档位 | 售价 | 单价 |
|---|---|---|
| 1 min | ¥5  | ¥5.00/min |
| 3 min | ¥12 | ¥4.00/min |
| 5 min | ¥18 | ¥3.60/min |
| 10 min | ¥32 | ¥3.20/min |
| **30 min** ⭐ | **¥88** | ¥2.93/min |
| 60 min | ¥158 | ¥2.63/min |

## 文件结构

```
trans/
├── wrangler.toml
├── package.json
├── migrations/
│   └── 0001_init.sql              # D1 schema
├── scripts/
│   └── gen-codes.mjs              # CLI: batch generate redemption codes
├── src/
│   ├── index.js                   # Worker entry: HTTP + WS routes
│   ├── room.js                    # Durable Object: signaling + OpenAI proxy
│   ├── auth.js                    # magic link, Google OAuth, WeChat OAuth, sessions
│   ├── codes.js                   # redemption code claim
│   └── db.js                      # D1 helpers
└── public/
    ├── index.html                 # SPA: home / login / account / create / join / room
    ├── styles.css
    ├── app.js                     # client logic (auth, room, AudioWorklet)
    └── pcm-worklet.js
```

## 安全提示

- `OPENAI_API_KEY` 只在 Worker 进程内存；客户端、git、日志都看不到。
- `.dev.vars` 已在 `.gitignore`，本地测试 key 不会进版本控制。
- 房间密码以明文比较，仅作"分享受限"用途；不是身份认证。
- 兑换码用过即作废（数据库层乐观锁）。

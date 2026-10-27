# 安全策略

## 报告漏洞

**请不要开公开 Issue。**

通过 GitHub 的 [Private vulnerability reporting](https://github.com/LZM2023/dsh-sofa-monitor/security/advisories/new) 提交，或直接联系仓库维护者。

请尽量包含：

- 受影响的版本 / 文件 / 行号
- 复现步骤或最小复现片段
- 实际影响（能读什么、能写什么、能打到哪个地址）
- 如果有修复建议，一并附上

**不要在报告里贴真实 API Key、Cookie、账号、订单号或任何真实商品数据。** 如果泄露已经发生，请先去服务商后台吊销凭据，再补齐说明。

## 本项目的安全边界

这些是**刻意保留**的行为，不算漏洞：

| 行为 | 说明 |
| --- | --- |
| 遇到登录墙 / 验证码 / 403 / 429 / 权限拒绝时停止 | 不做自动重试、不做绕过、不做风控对抗 |
| 不读取 Cookie、账号信息、评价区、私信 | 只读商品详情页公开内容 |
| 来源 URL 含 `token`/`cookie`/`auth`/`session`/`password`/`secret` 参数时直接拒绝 | 防止凭据经 URL 进入日志与存档 |
| 图片 CDN 域名白名单 + 路径前缀校验 | 只接受 `img*.360buyimg.com` 的公开 CMS 路径，拒绝带 query/fragment/端口/账号 |
| 云端返回的图片地址必须同源或属于已知 CDN，且只允许 `https:` | 防 SSRF 与开放重定向 |
| 服务地址不允许内嵌账号、密钥、query、fragment | 防止把凭据写进配置后被回显 |
| 密钥不回传前端 | 设置接口只返回 `apiKeyConfigured: true/false` |
| 模板是受约束 JSON，不执行代码 | 模板库不可作为任意代码入口 |
| 原生宿主适配强制版本 + 文件哈希校验，不匹配就拒绝覆盖 | 防止在未知 DSH 版本上盲目打补丁 |

## 需要你注意的地方

**这个插件会修改宿主 DSH 的部分文件。** 具体是：

- `assets/native-desktop/*.cjs`：对 DSH Desktop 原生浏览器桥的本地适配，通过 `scripts/repair-desktop.mjs --apply` 写入
- `scripts/repair-browser-helper.mjs`：对 DSH 浏览器助手扩展的兼容性修复

这两个脚本都是**先校验版本与原文件哈希，匹配才写、写前备份**，不匹配就退出并保留诊断输出。`install-windows.ps1` 里它们失败只 `Write-Warning`，不会强推。

即便如此：

- 安装前请自行确认 `assets/native-desktop/host-baseline.json` 里的基线版本与你的 DSH 版本一致
- DSH 升级后**必须重新核对**这套适配，不要直接覆盖
- 不想动宿主文件的话，只装 npm 包、不跑 `repair-desktop.mjs` 也能使用「外部浏览器助手」这条链路

## 本机 HTTP 接口的信任边界

插件后端会在本机回环地址上开一个 HTTP 接口供面板调用。它的防护是：

- 仅接受回环地址（`localhost` / `127.0.0.1` / `[::1]`）
- 校验 `Origin` 必须与 `Host` 一致，拒绝 `Sec-Fetch-Site: cross-site|same-site`
- 不下发任何 CORS 头，响应带 `Cross-Origin-Resource-Policy: same-origin`
- 所有写操作（POST）要求 `x-sofa-monitor-token`，用 `timingSafeEqual` 比较

**需要你知道的一点：** 操作 token 由 `GET /sofa-monitor/v1/bootstrap` 下发给页面，这一步不校验 token 本身（页面首次加载时还没有 token，是设计上的先有鸡还是先有蛋）。**因此本机上任何能发 HTTP 请求的进程都可以读到这个 token，进而调用写接口。**

这与绝大多数本地开发/桌面应用的本地接口是同一类信任模型 —— 它防的是「别的网站通过你的浏览器打你」，不是「你本机上的恶意程序」。如果你的威胁模型包含本机不可信进程，请不要在那种机器上运行本插件，或自己加一层反向代理鉴权。

只读接口（`files/`、`cards/`、商品图、模板快照）不需要 token，但同样受上述回环 + Origin 约束。

## 密钥管理

| 位置 | 内容 |
| --- | --- |
| `image-processing-private.json` | 云端图片处理的 API Key（明文，落在本机数据目录） |
| `qwen-private.json` | 旧版通义千问配置（兼容读取） |
| `QWEN_API_KEY` / `DASHSCOPE_API_KEY` | 环境变量，优先级高于上述文件 |

这些文件都被 `.gitignore` 排除。**请不要把数据目录整体提交到任何仓库、网盘同步目录或备份服务。**

## 支持范围

只对**最新版本**接受安全修复。历史版本不做回溯补丁。

# 阿里云函数计算代理

这是 GitHub Pages 的中国服务端代理：

```text
手机浏览器 → GitHub Pages → 阿里云函数计算（中国）→ 模型 API
```

`web/` 可以直接作为一个 **Web 函数** 的代码目录上传。创建函数时选择：

- 地域：国内地域（例如上海）
- 运行环境：自定义运行时 → Node.js → Node.js 20（Debian 11）
- 启动命令：`npm run start`
- 监听端口：`9000`
- HTTP 触发器：公网访问、无需认证，允许 `POST` 和 `OPTIONS`
- 内存：至少 256 MB；超时：60 秒

在函数的环境变量中配置（在控制台填写，不写入仓库）：

- `LUNA_API_KEY`：模型密钥
- `LUNA_BASE_URL`：`https://xiaohondou.com/v1`
- `LUNA_MODEL`：`gpt-5.6-luna`

部署完成后，把 HTTP 触发器 URL 填到根目录 `runtime-config.js` 的 `NUTRI_API_ENDPOINT`，再推送 GitHub Pages。代码仅允许 `https://zkccz.github.io` 跨域调用；接口也限制单实例内每 IP 10 分钟 10 次，作为 demo 的基础保护。接口返回的 `riceEquivalent` 是“每份”基准值，网页会按本次克数只换算一次。

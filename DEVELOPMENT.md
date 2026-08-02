# my-dashboard 开发说明

## 安装依赖

```powershell
npm install
```

## 本地开发

开发服务器使用 HTTPS。模块使用安全的单模块编辑锁和 Web Crypto，因此通过局域网访问时也需要 HTTPS。

先安装一次 [mkcert](https://github.com/FiloSottile/mkcert)。Windows 可以执行：

```powershell
winget install FiloSottile.mkcert
```

然后单独运行证书配置命令。它会安装本机根证书，并根据当前局域网 IP 生成或刷新开发证书：

```powershell
npm run setup:https
```

之后启动开发服务器：

```powershell
npm run dev
```

手机访问：

```text
https://<局域网IP>:5173
```

首次使用时，将 `mkcert -CAROOT` 输出目录中的 `rootCA.pem` 安装并信任到手机。不要复制或上传 `rootCA-key.pem`。如果更换了局域网、导致本机 IP 变化，请重新运行 `npm run setup:https`。

证书和私钥保存在 `.cert/`，该目录不会提交到 Git。

## 预览生产构建

```powershell
npm run build
npm run preview
```

`npm run preview` 使用与本地开发相同的 HTTPS 证书；如果证书不存在，请先运行 `npm run setup:https`。

## 验证

```powershell
npm test
npm run build
```

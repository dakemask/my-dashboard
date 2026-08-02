# my-dashboard

一个开箱即用的个人仪表盘。

## 使用

直接打开网站，无需安装：

<https://dakemask.github.io/my-dashboard/>

默认情况下，数据只保存在当前浏览器中。清除浏览器站点数据可能会同时清除这些内容。

## 多设备同步

如需在多台设备间同步数据：

1. 在 GitHub 中新建名为 `my-dashboard-data` 的**私人仓库**。
2. 确保仓库已有 `main` 分支。创建仓库时可以勾选添加 README。
3. 创建可读写该仓库 Contents 的 GitHub token。
4. 在仪表盘首页打开“账户设置”，添加 GitHub 用户名和 token。

## 局域网 HTTPS 开发

手机通过局域网访问开发版时，必须使用 HTTPS，才能启用安全的单模块编辑锁和 Web Crypto。

先安装 [mkcert](https://github.com/FiloSottile/mkcert)，然后在项目根目录执行（将 `<局域网IP>` 替换为开发电脑的 IPv4 地址）：

```powershell
New-Item -ItemType Directory -Force .cert
mkcert -install
mkcert -key-file .cert/my-dashboard-key.pem -cert-file .cert/my-dashboard.pem localhost 127.0.0.1 ::1 <局域网IP>
```

再运行：

```powershell
npm run dev
```

手机访问 `https://<局域网IP>:5173`。首次使用时，需要把 `mkcert -CAROOT` 输出目录中的根证书安装并信任到手机；`.cert/` 已被 Git 忽略，不会提交证书或私钥。

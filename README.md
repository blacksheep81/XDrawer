# X 抽屉

在你自己的浏览器中整理 X（Twitter）书签、喜欢和手动保存帖子的本地资料库。

- 数据保存在当前浏览器的 IndexedDB 中，不经过开发者的服务器
- 支持全文搜索、标签、备注、稍后读、智能分类和批量整理
- 支持导出和导入备份
- 可选：通过你自己的 Google Drive 在多台设备间同步

## 安装

1. 打开 `chrome://extensions`，开启“开发者模式”
2. 点击“加载已解压的扩展程序”，选择本目录

## Google Drive 同步

同步文件保存在 Drive 的应用专属隐藏目录（`drive.appdata`），在 Drive 界面里看不到，也只有本扩展能读取。帖子、人物、已保存视图、标签和智能分类都会同步；导入记录只留在本机。登录 X 的凭据不会上传。

合并规则：

- 帖子正文取最新一次抓取，标签、备注和阅读状态取最新一次整理，两者互不覆盖
- 删除会同步到其他设备；删除后如果又重新导入，帖子会恢复
- 云端文件无法读取时会停止同步，不会覆盖云端和本地数据

### 配置

扩展 ID 已由 `manifest.json` 的 `key` 固定为 `cfpjibdhkfnibjiigeiebdmmodmkclcd`。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 新建项目，并启用 Google Drive API
2. 配置 OAuth 同意屏幕：用户类型选“外部”，添加 `drive.appdata`、`openid`、`email` 权限，并把自己的 Google 账号加为测试用户
3. 创建 OAuth 客户端，类型选“Web 应用”，已获授权的重定向 URI 填写：
   `https://cfpjibdhkfnibjiigeiebdmmodmkclcd.chromiumapp.org/`
4. 把客户端 ID 填入 `sync.js` 的 `GOOGLE_CLIENT_ID`，然后在 `chrome://extensions` 刷新扩展

未填写客户端 ID 时同步不会启动，数据仍只保存在本机。

## 测试

同步测试在真实的 Chrome 里运行，但 Google 登录和 Drive 都是内存里的模拟实现，不会访问网络，也不碰你日常的浏览器资料。需要 Python 3 和 Chrome（或 Edge）：

```bash
python tests/sync/run.py
```

全部通过时退出码为 0。找不到浏览器时，用环境变量 `CHROME` 指定路径。

想在浏览器里看页面和调试：

```bash
python tests/sync/run.py --serve
```

它会打印一个本地地址，打开后页面会显示每一项结果。

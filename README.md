# 拾羽

把 X（Twitter）上的书签、喜欢和手动保存的帖子，一片片拾进你自己浏览器里的本地收藏库。

- 数据保存在当前浏览器的 IndexedDB 中，不经过开发者的服务器
- 支持全文搜索、标签、备注、稍后读和批量整理
- 支持导出和导入备份
- 可选：通过你自己的 Google Drive 在多台设备间同步

## 安装

1. 打开 `chrome://extensions`，开启“开发者模式”
2. 点击“加载已解压的扩展程序”，选择本目录

## Google Drive 同步

同步文件保存在 Drive 的应用专属隐藏目录（`drive.appdata`），在 Drive 界面里看不到，也只有本扩展能读取。登录 X 的凭据不会上传。

合并规则：

- 帖子正文取最新一次抓取，标签、备注和阅读状态取最新一次整理，两者互不覆盖
- 删除会同步到其他设备；删除后如果又重新导入，帖子会恢复
- 云端文件无法读取时会停止同步，不会覆盖云端和本地数据

### 首次配置

扩展固定 ID：`olmbainoigkndjolpfbkkbmageplpcgk`

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 新建项目，并启用 Google Drive API
2. 配置 OAuth 同意屏幕：用户类型选“外部”，添加 `drive.appdata`、`openid`、`email` 权限，并把自己的 Google 账号加为测试用户
3. 创建 OAuth 客户端，类型选“Web 应用”，已获授权的重定向 URI 填写：
   `https://olmbainoigkndjolpfbkkbmageplpcgk.chromiumapp.org/`
4. 把客户端 ID 填入 `sync.js` 的 `GOOGLE_CLIENT_ID`
5. **先在旧版本中导出 JSON 备份**，再把公钥写入 `manifest.json` 的 `key` 字段：固定 ID 后扩展的存储位置会变，需要导入备份才能恢复数据

`shiyu-extension.pem` 是这个 ID 对应的私钥，已被 git 忽略，请不要提交或打包发布。

## 致谢

本项目基于开源项目 **X Drawer（X 서랍）** 修改，原作版权归 X Drawer contributors 所有，
依据 MIT 许可证使用，完整声明见 [LICENSE](LICENSE)。

“拾羽”这个名称和图标是本分支自己的品牌，与 X Corp. 无关。

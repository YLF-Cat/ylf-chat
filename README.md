# ylf-chat

一款web聊天软件

目前支持的功能有：

* Markdown & LaTeX 支持
* 深色模式
* 邮箱注册（发送验证邮件，我使用的是飞书邮箱）
* 插入表情，内置QQ的部分表情。收藏表情。
* 发送文件，下载文件（我使用 Cloudflare R2 存储）
* 回复消息
* 撤回消息
* @用户
* 头像使用 Cravatar/url/上传

全部代码使用 AI 生成。

## 使用方法

1. `npm install`

2. `npm start`

默认开在 `1145` 端口。

## 配置

1. 在 `mailer.js` 填写你的邮箱参数
2. 在 `config/r2.json` 填写你的对象存储参数
3. 在 `public/config/emojis.json` 修改内置表情

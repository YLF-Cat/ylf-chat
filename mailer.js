const nodemailer = require('nodemailer');

const SMTP_USER = 'Your_mail';
const SMTP_APP_PASSWORD =
  process.env.SMTP_APP_PASSWORD || 'Your_password';

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.feishu.cn',
      port: 465,
      secure: true,
      auth: {
        user: SMTP_USER,
        pass: SMTP_APP_PASSWORD
      }
    });
  }
  return transporter;
}

async function sendMail(options) {
  if (!SMTP_APP_PASSWORD || SMTP_APP_PASSWORD.includes('REPLACE_WITH_FEISHU_APP_PASSWORD')) {
    console.warn('[mailer] SMTP app password is not configured; skipped sending email.');
    return;
  }
  await getTransporter().sendMail(options);
}

async function sendVerificationEmail(to, token, displayName) {
  if (!token || !to) return;

  const link = `https://frp.ylfcat.icu/verify?token=${token}`;
  const safeName = displayName || '朋友';
  const subject = '验证你的漫游聊天室账号';

  const textContent = [    `你好，${safeName}：`,    '',    '感谢注册漫游聊天室，为了保证账号安全，请点击以下链接完成邮箱验证：',    link,    '',    '如果不是你本人操作，可以忽略这封邮件。',    '',    '—— 漫游聊天室'  ].join('\n');

  const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${subject}</title>
</head>
<body style="font-family: Arial, 'Microsoft YaHei', sans-serif; background:#f4f4f8; margin:0; padding:32px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 24px 48px rgba(15,23,42,0.12);">
    <tr>
      <td style="background:linear-gradient(135deg,#2563eb,#7c3aed); color:#ffffff; padding:28px 32px; font-size:20px; font-weight:600;">
        漫游聊天室 · 邮箱验证
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 16px 0; font-size:16px; color:#0f172a;">你好，${safeName}：</p>
        <p style="margin:0 0 16px 0; color:#475569; line-height:1.6;">
          感谢注册漫游聊天室。为了激活你的账号并参与聊天，请在 24 小时内点击下方按钮完成邮箱验证。
        </p>
        <p style="margin:24px 0;">
          <a href="${link}" style="display:inline-block; padding:14px 26px; border-radius:999px; color:#ffffff; background:linear-gradient(135deg,#2563eb,#7c3aed); font-weight:600; text-decoration:none;">
            完成邮箱验证
          </a>
        </p>
        <p style="margin:0; color:#94a3b8; font-size:13px;">
          如果按钮无法点击，请复制如下链接到浏览器打开：<br>
          <span style="word-break:break-all;">${link}</span>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 32px; background:#f8fafc; color:#94a3b8; font-size:12px;">
        本邮件由系统自动发送，请勿直接回复。
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  await sendMail({
    from: `"漫游聊天室" <${SMTP_USER}>`,
    to,
    subject,
    text: textContent,
    html: htmlContent
  });
}

async function sendPasswordResetEmail(to, displayName, code) {
  if (!code || !to) return;

  const safeName = displayName || '朋友';
  const subject = '重置你的漫游聊天室密码';

  const textContent = [    `你好，${safeName}：`,    '',    '我们收到了你重置密码的请求，请在页面输入以下验证码完成操作：',    '',    `验证码：${code}`,    '',    '验证码有效期 15 分钟。如果不是你本人操作，请忽略。'  ].join('\n');

  const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${subject}</title>
</head>
<body style="font-family: Arial, 'Microsoft YaHei', sans-serif; background:#f4f4f8; margin:0; padding:32px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 24px 48px rgba(15,23,42,0.12);">
    <tr>
      <td style="background:linear-gradient(135deg,#2563eb,#7c3aed); color:#ffffff; padding:26px 30px; font-size:20px; font-weight:600;">
        漫游聊天室 · 密码重置
      </td>
    </tr>
    <tr>
      <td style="padding:28px 30px;">
        <p style="margin:0 0 18px 0; font-size:16px; color:#0f172a;">你好，${safeName}：</p>
        <p style="margin:0 0 18px 0; color:#475569; line-height:1.6;">
          我们收到了你重置密码的请求，请在重置页面输入下方验证码。验证码有效期为 15 分钟。
        </p>
        <p style="margin:24px 0; text-align:center;">
          <span style="display:inline-block; font-size:28px; letter-spacing:0.35em; padding:14px 26px; border-radius:14px; background:rgba(37,99,235,0.1); color:#1d4ed8; font-weight:700;">
            ${code}
          </span>
        </p>
        <p style="margin:0; color:#94a3b8; font-size:13px;">
          如果你没有请求重置密码，可以忽略这封邮件。
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  await sendMail({
    from: `"漫游聊天室" <${SMTP_USER}>`,
    to,
    subject,
    text: textContent,
    html: htmlContent
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  SMTP_USER
};

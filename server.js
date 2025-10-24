const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const db = require('./db');
const { renderMarkdown } = require('./markdown');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./mailer');
const {
  isConfigured: isStorageConfigured,
  uploadObject,
  createPresignedUrl
} = require('./storage');

const HISTORY_PAGE_SIZE = 40;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_NAME_LENGTH = 32;
const PASSWORD_MIN_LENGTH = 8;
const VERIFICATION_TOKEN_TTL = 1000 * 60 * 60 * 24;
const RESET_CODE_TTL = 1000 * 60 * 15;
const MAX_FILE_UPLOAD_SIZE = 200 * 1024 * 1024;

const FILE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
const sessionsDir = path.join(dataDir, 'sessions');
const katexPackageDir = path.dirname(require.resolve('katex/package.json'));
const katexDistDir = path.join(katexPackageDir, 'dist');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const sessionMiddleware = session({
  store: new FileStore({
    path: sessionsDir,
    retries: 0
  }),
  secret: process.env.SESSION_SECRET || 'change-this-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    sameSite: 'lax',
    secure: false
  }
});

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const decodedName = decodeOriginalName(file.originalname);
    const ext = path.extname(decodedName || '').toLowerCase() || '.png';
    const prefix = req.session && req.session.userId ? `u${req.session.userId}` : 'guest';
    const unique = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${prefix}-${unique}${ext}`);
  }
});

const avatarUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 PNG、JPG、GIF 或 WebP 格式的图片'));
    }
  }
});

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_UPLOAD_SIZE,
    files: 1
  }
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
app.use('/vendor/katex', express.static(katexDistDir, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

const connectedUsers = new Map();
const userSockets = new Map();
const disconnectTimers = new Map();

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on('connection', socket => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) {
    socket.emit('auth-required');
    socket.disconnect(true);
    return;
  }

  const user = db.getUserById(userId);
  if (!user) {
    socket.emit('auth-required');
    socket.disconnect(true);
    return;
  }

  const mode = parseConnectionMode(socket.handshake);
  socket.data.userId = user.id;
  socket.data.mode = mode;
  connectedUsers.set(socket.id, user.id);

  const hadPendingDeparture = disconnectTimers.has(user.id);
  if (hadPendingDeparture) {
    clearTimeout(disconnectTimers.get(user.id));
    disconnectTimers.delete(user.id);
  }

  let socketsForUser = userSockets.get(user.id);
  if (!socketsForUser) {
    socketsForUser = new Set();
    userSockets.set(user.id, socketsForUser);
  }
  const firstConnection = socketsForUser.size === 0 && !hadPendingDeparture;
  socketsForUser.add(socket.id);

  const userPayload = mapUserToClient(user);

  if (mode === 'presence') {
    socket.emit('presence-init', {
      self: userPayload,
      roster: buildRoster(),
      online: userSockets.size
    });
  } else {
    const initialRows = db.getMessagesPage(HISTORY_PAGE_SIZE);
    const historyPayload = initialRows.map(row => {
      const entry = formatMessagePayload(row, null);
      return entry;
    });

    socket.emit('chat-init', {
      self: userPayload,
      history: historyPayload,
      historyDone: historyPayload.length < HISTORY_PAGE_SIZE,
      online: userSockets.size,
      roster: buildRoster()
    });
  }

  if (firstConnection) {
    socket.broadcast.emit('system-message', `${user.display_name} 加入了聊天`);
    io.emit('roster-update', buildRoster());
  }

  io.emit('online-count', userSockets.size);

  socket.on('chat-message', data => {
    let content = '';
    let replyToId = null;

    if (typeof data === 'string') {
      content = data.trim();
    } else if (typeof data === 'object' && data !== null) {
      content = (data.content || '').trim();
      if (Number.isInteger(data.replyTo)) {
        replyToId = data.replyTo;
      }
    }

    if (!content) {
      return;
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      socket.emit('system-message', '消息长度不能超过 5000 个字符。');
      return;
    }

    const freshUser = db.getUserById(socket.data.userId);
    if (!freshUser) {
      socket.emit('auth-required');
      socket.disconnect(true);
      return;
    }
    if (!freshUser.is_verified) {
      socket.emit('system-message', '邮箱尚未验证，暂时无法发送消息。请在邮箱中完成验证后刷新页面。');
      return;
    }

    const mentions = extractMentions(content, freshUser.id);
    const createdAt = Date.now();
    const saved = db.saveMessage(freshUser.id, content, createdAt, replyToId);

    const payload = formatMessagePayload(
      {
        id: saved.id,
        user_id: freshUser.id,
        content: content,
        created_at: createdAt,
        display_name: freshUser.display_name,
        email: freshUser.email,
        avatar_source: freshUser.avatar_source,
        avatar_url: freshUser.avatar_url,
        is_deleted: saved.is_deleted,
        reply_to_id: saved.reply_to_id
      },
      mentions.map
    );
    payload.mentions = mentions.ids;

    io.emit('chat-message', payload);

    mentions.ids.forEach(id => {
      const socketsSet = userSockets.get(id);
      if (!socketsSet) return;
      socketsSet.forEach(sid => {
        io.to(sid).emit('mention', {
          from: payload.author,
          text: payload.text,
          html: payload.html,
          time: payload.time
        });
      });
    });
  });

  socket.on('delete-message', ({ messageId }) => {
    if (!Number.isInteger(messageId)) return;
    const result = db.deleteMessage(messageId, socket.data.userId);

    if (result.success) {
      io.emit('message-deleted', { messageId });
    } else if (result.reason === 'permission_denied') {
      socket.emit('system-message', '你不能撤回别人的消息。');
    }
  });

  socket.on('history-request', params => {
    if (!params || typeof params !== 'object') return;
    const beforeId = Number(params.beforeId);
    if (!Number.isInteger(beforeId) || beforeId <= 0) return;

    const rows = db.getMessagesPage(HISTORY_PAGE_SIZE, beforeId);
    if (!rows.length) {
      socket.emit('history-chunk', { messages: [], done: true, oldestId: beforeId });
      return;
    }

    const chunk = rows.map(row => {
      const entry = formatMessagePayload(row, null);
      return entry;
    });

    socket.emit('history-chunk', {
      messages: chunk,
      done: rows.length < HISTORY_PAGE_SIZE,
      oldestId: chunk[0].id
    });
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);

    const socketsForUser = userSockets.get(user.id);
    if (socketsForUser) {
      socketsForUser.delete(socket.id);
      if (socketsForUser.size === 0) {
        scheduleDeparture(user.id);
      }
    }
  });
});

app.post('/api/auth/register', avatarUpload.single('avatarFile'), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const passwordConfirm = String(req.body.passwordConfirm || '');
    const displayName = sanitizeDisplayName(req.body.displayName || '');
    let avatarSource = String(req.body.avatarSource || 'gravatar').toLowerCase();
    const avatarUrlInput = String(req.body.avatarUrl || '').trim();

    if (!email || !validateEmail(email)) {
      cleanupUploadedFile(req.file);
      return res.status(422).json({ message: '邮箱格式不正确' });
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      cleanupUploadedFile(req.file);
      return res
        .status(422)
        .json({ message: `密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符` });
    }
    if (passwordConfirm && password !== passwordConfirm) {
      cleanupUploadedFile(req.file);
      return res.status(422).json({ message: '两次密码输入不一致' });
    }
    if (!displayName) {
      cleanupUploadedFile(req.file);
      return res.status(422).json({ message: '请填写昵称' });
    }

    const existing = db.getUserByEmail(email);
    if (existing) {
      cleanupUploadedFile(req.file);
      return res.status(409).json({ message: '该邮箱已注册，请直接登录' });
    }

    let storedAvatarUrl = null;
    if (avatarSource === 'url') {
      if (!avatarUrlInput || !validateHttpUrl(avatarUrlInput)) {
        cleanupUploadedFile(req.file);
        return res.status(422).json({ message: '头像链接无效，请使用 http(s) 链接' });
      }
      storedAvatarUrl = avatarUrlInput;
    } else if (avatarSource === 'upload') {
      if (!req.file) {
        return res.status(422).json({ message: '请上传一张头像图片' });
      }
      storedAvatarUrl = `/uploads/${req.file.filename}`;
    } else {
      avatarSource = 'gravatar';
    }

    if (avatarSource !== 'upload' && req.file) {
      cleanupUploadedFile(req.file);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = Date.now() + VERIFICATION_TOKEN_TTL;

    const user = db.createUser({
      email,
      password_hash: passwordHash,
      display_name: displayName,
      avatar_source: avatarSource,
      avatar_url: storedAvatarUrl,
      is_verified: false,
      verification_token: verificationToken,
      verification_expires: verificationExpires
    });

    try {
      await sendVerificationEmail(user.email, verificationToken, displayName);
    } catch (mailError) {
      console.error('[mailer] Failed to send verification email:', mailError);
    }

    res
      .status(201)
      .json({ success: true, message: '注册成功，验证邮件已发送，请查收邮箱完成验证。' });
  } catch (error) {
    cleanupUploadedFile(req.file);
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!email || !validateEmail(email) || !password) {
      return res.status(422).json({ message: '请输入有效的邮箱和密码' });
    }

    const user = db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ message: '邮箱或密码错误' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ message: '邮箱或密码错误' });
    }

    req.session.userId = user.id;
    res.json({ success: true, user: mapUserToClient(user), roster: buildRoster() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/session', (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.json({ authenticated: false });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: mapUserToClient(user),
    roster: buildRoster()
  });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }
  if (user.is_verified) {
    return res.status(400).json({ message: '邮箱已验证，无需重发' });
  }

  const verificationToken = crypto.randomBytes(32).toString('hex');
  const verificationExpires = Date.now() + VERIFICATION_TOKEN_TTL;
  db.updateUserVerification({
    id: user.id,
    isVerified: false,
    token: verificationToken,
    expires: verificationExpires
  });

  try {
    await sendVerificationEmail(user.email, verificationToken, user.display_name);
  } catch (mailError) {
    console.error('[mailer] Failed to resend verification email:', mailError);
  }

  res.json({ success: true, message: '验证邮件已重新发送，请查收邮箱。' });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email || !validateEmail(email)) {
    return res.status(422).json({ message: '请输入有效的邮箱地址' });
  }

  const user = db.getUserByEmail(email);
  if (!user) {
    return res.json({ success: true });
  }

  const code = generateResetCode();
  const codeHash = await bcrypt.hash(code, 12);
  const expires = Date.now() + RESET_CODE_TTL;
  db.setPasswordResetCode({ id: user.id, codeHash, expires });

  try {
    await sendPasswordResetEmail(user.email, user.display_name, code);
  } catch (error) {
    console.error('[mailer] Failed to send reset email:', error);
  }

  res.json({ success: true });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  const password = String(req.body.password || '');

  if (!email || !validateEmail(email)) {
    return res.status(422).json({ message: '邮箱格式不正确' });
  }
  if (!code || code.length !== 6) {
    return res.status(422).json({ message: '验证码格式不正确' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res
      .status(422)
      .json({ message: `密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符` });
  }

  const user = db.getUserByEmail(email);
  if (!user || !user.reset_code_hash || !user.reset_code_expires) {
    return res.status(400).json({ message: '验证码无效或已过期，请重新获取' });
  }
  if (user.reset_code_expires < Date.now()) {
    db.clearPasswordResetCode(user.id);
    return res.status(400).json({ message: '验证码已过期，请重新获取' });
  }

  const match = await bcrypt.compare(code, user.reset_code_hash);
  if (!match) {
    return res.status(400).json({ message: '验证码不正确，请重新输入' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  db.updateUserPassword({ id: user.id, passwordHash });
  db.clearPasswordResetCode(user.id);

  res.json({ success: true, message: '密码已更新，请使用新密码登录。' });
});

app.post('/api/users/me', avatarUpload.single('avatarFile'), (req, res, next) => {
  const userId = req.session.userId;
  if (!userId) {
    cleanupUploadedFile(req.file);
    return res.status(401).json({ message: '未登录' });
  }

  const user = db.getUserById(userId);
  if (!user) {
    cleanupUploadedFile(req.file);
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }

  try {
    const displayName = sanitizeDisplayName(req.body.displayName || user.display_name);
    let avatarSource = String(req.body.avatarSource || user.avatar_source).toLowerCase();
    const avatarUrlInput = String(req.body.avatarUrl || '').trim();

    if (!displayName) {
      cleanupUploadedFile(req.file);
      return res.status(422).json({ message: '昵称不能为空' });
    }

    let nextAvatarUrl = user.avatar_url;

    if (avatarSource === 'url') {
      if (!avatarUrlInput || !validateHttpUrl(avatarUrlInput)) {
        cleanupUploadedFile(req.file);
        return res.status(422).json({ message: '头像链接无效' });
      }
      nextAvatarUrl = avatarUrlInput;
      if (user.avatar_source === 'upload') {
        cleanupStoredAvatar(user.avatar_url);
      }
      if (req.file) {
        cleanupUploadedFile(req.file);
      }
    } else if (avatarSource === 'upload') {
      if (req.file) {
        nextAvatarUrl = `/uploads/${req.file.filename}`;
        if (user.avatar_source === 'upload') {
          cleanupStoredAvatar(user.avatar_url);
        }
      } else if (user.avatar_source === 'upload' && user.avatar_url) {
        nextAvatarUrl = user.avatar_url;
      } else {
        return res.status(422).json({ message: '请上传头像图片' });
      }
    } else {
      avatarSource = 'gravatar';
      nextAvatarUrl = null;
      if (user.avatar_source === 'upload') {
        cleanupStoredAvatar(user.avatar_url);
      }
      if (req.file) {
        cleanupUploadedFile(req.file);
      }
    }

    db.updateUserProfile({
      id: user.id,
      displayName,
      avatarSource,
      avatarUrl: nextAvatarUrl
    });

    const updatedUser = db.getUserById(user.id);
    res.json({ success: true, user: mapUserToClient(updatedUser), roster: buildRoster() });
  } catch (error) {
    cleanupUploadedFile(req.file);
    next(error);
  }
});

app.post('/api/users/me/password', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }

  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const confirm = String(req.body.confirmPassword || '');

  if (!oldPassword || !newPassword || !confirm) {
    return res.status(422).json({ message: '请完整填写旧密码和新密码' });
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return res
      .status(422)
      .json({ message: `新密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符` });
  }
  if (newPassword !== confirm) {
    return res.status(422).json({ message: '两次输入的新密码不一致' });
  }

  const match = await bcrypt.compare(oldPassword, user.password_hash);
  if (!match) {
    return res.status(401).json({ message: '旧密码不正确' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  db.updateUserPassword({ id: user.id, passwordHash });

  res.json({ success: true, message: '密码已更新，请使用新密码重新登录。' });
});

app.get('/api/stickers', (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }
  const stickers = db.getUserStickers(user.id).map(formatStickerForClient);
  res.json({ stickers });
});

app.post('/api/stickers', (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }

  const description = String(req.body.description || '').trim().slice(0, 120);
  const previewUrl = String(req.body.previewUrl || '').trim();
  const imageUrl = String(req.body.imageUrl || '').trim();

  if (!description) {
    return res.status(422).json({ message: '请填写描述' });
  }
  if (!previewUrl || !validateHttpUrl(previewUrl)) {
    return res.status(422).json({ message: '预览图链接无效' });
  }
  if (!imageUrl || !validateHttpUrl(imageUrl)) {
    return res.status(422).json({ message: '实际图链接无效' });
  }

  const result = db.addUserSticker({
    id: user.id,
    description,
    previewUrl,
    imageUrl
  });

  if (!result.success) {
    if (result.reason === 'limit') {
      return res
        .status(409)
        .json({ message: '收藏表情数量已达上限，请先删除一些再添加。' });
    }
    return res.status(500).json({ message: '保存失败，请稍后再试。' });
  }

  res
    .status(201)
    .json({
      success: true,
      sticker: formatStickerForClient(result.sticker),
      stickers: result.stickers.map(formatStickerForClient)
    });
});

app.delete('/api/stickers/:id', (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }
  const stickerId = String(req.params.id || '').trim();
  if (!stickerId) {
    return res.status(400).json({ message: '表情不存在' });
  }
  const result = db.removeUserSticker({ id: user.id, stickerId });
  if (!result.success) {
    return res.status(404).json({ message: '表情不存在' });
  }
  res.status(204).end();
});

app.post('/api/files/upload', fileUpload.single('file'), async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }
  if (!req.file) {
    return res.status(422).json({ message: '请选择要上传的文件。' });
  }
  if (!isStorageConfigured()) {
    return res.status(503).json({ message: '文件存储尚未配置，请联系管理员。' });
  }

  const decodedName = decodeOriginalName(req.file.originalname);
  const originalName = sanitizeFileName(decodedName || '未命名文件');
  const code = generateFileCode();
  const objectKey = buildObjectKey(user.id, code, originalName);
  const contentDisposition = buildContentDisposition(originalName);

  try {
    await uploadObject({
      key: objectKey,
      body: req.file.buffer,
      contentType: req.file.mimetype || 'application/octet-stream',
      contentDisposition
    });

    const record = db.saveFileRecord({
      userId: user.id,
      code,
      objectKey,
      fileName: originalName,
      size: req.file.buffer.length,
      contentType: req.file.mimetype || 'application/octet-stream'
    });

    res.status(201).json({
      success: true,
      file: formatFileForClient(record, user.display_name),
      message: '文件上传成功。'
    });
  } catch (error) {
    console.error('[files] upload failed', error);
    res.status(500).json({ message: '文件上传失败，请稍后再试。' });
  }
});

app.get('/api/files/me', (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '未登录' });
  }
  const records = db.getFilesByUser(user.id).map(record =>
    formatFileForClient(record, user.display_name)
  );
  res.json({ files: records });
});

app.get('/api/files/:code', (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ message: '文件编码无效。' });
  }
  const record = db.getFileByCode(code);
  if (!record) {
    return res.status(404).json({ message: '文件不存在或已删除。' });
  }
  const owner = db.getUserById(record.user_id);
  res.json({
    success: true,
    file: formatFileForClient(record, owner ? owner.display_name : '未知用户')
  });
});

app.get('/api/files/:code/presign', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: '未登录' });
  }
  if (!isStorageConfigured()) {
    return res.status(503).json({ message: '文件存储尚未配置。' });
  }
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ message: '文件编码无效。' });
  }
  const record = db.getFileByCode(code);
  if (!record) {
    return res.status(404).json({ message: '文件不存在或已删除。' });
  }
  try {
    const link = await createPresignedUrl(record.object_key, 600);
    res.json({
      success: true,
      url: link.url,
      expiresIn: link.expiresIn,
      fileName: record.file_name,
      size: record.size,
      contentType: record.content_type
    });
  } catch (error) {
    console.error('[files] presign failed', error);
    res.status(500).json({ message: '获取下载链接失败，请稍后再试。' });
  }
});

app.get('/verify', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).send(renderVerificationPage('验证链接无效，请重新请求邮件。', false));
  }

  const result = db.verifyUserByToken(token);
  if (!result.success) {
    if (result.reason === 'expired') {
      return res
        .status(410)
        .send(renderVerificationPage('验证链接已过期，请重新请求验证邮件。', false));
    }
    return res
      .status(404)
      .send(renderVerificationPage('验证链接不存在或已失效。', false));
  }

  if (result.user) {
    req.session.userId = result.user.id;
  }

  const message = result.already
    ? '该邮箱已完成验证，可以直接登录。'
    : '邮箱验证成功，现在可以回到聊天室畅聊了。';
  res.send(renderVerificationPage(message, true));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: err.message });
  }
  res.status(500).json({ message: '服务器开小差了，请稍后再试。' });
});

const PORT = process.env.PORT || 1145;
server.listen(PORT, () => {
  console.log(`Chat server listening on http://localhost:${PORT}`);
});

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateHttpUrl(value) {
  if (!value || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeDisplayName(name) {
  return String(name || '').trim().slice(0, MAX_NAME_LENGTH);
}

function mapUserToClient(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    avatarSource: user.avatar_source,
    avatarUrl: buildAvatarUrl(user),
    isVerified: Boolean(user.is_verified)
  };
}

function formatMessagePayload(row, mentionMap) {
  if (!row) return {};
  
  if (row.user_id === null) {
    return {
      id: row.id,
      userId: null,
      author: '系统消息',
      avatarUrl: 'https://cravatar.cn/avatar?d=mp&s=160',
      text: row.content,
      html: `<i>${escapeHtml(row.content)}</i>`,
      time: row.created_at,
      isDeleted: false,
      replyToId: null,
      mentions: []
    };
  }

  if (row.is_deleted) {
    return {
      id: row.id,
      userId: row.user_id,
      author: row.display_name,
      avatarUrl: buildAvatarUrl(row),
      text: `${row.display_name} 撤回了一条消息`,
      html: `<i>${escapeHtml(row.display_name)} 撤回了一条消息</i>`,
      time: row.created_at,
      isDeleted: true,
      replyToId: null,
      mentions: []
    };
  }

  const text = typeof row.content === 'string' ? row.content : '';
  let replyHeaderHtml = '';

  if (row.reply_to_id) {
    const originalMessage = db.getMessageById(row.reply_to_id);
    if (originalMessage) {
      const authorAvatar = buildAvatarUrl(originalMessage);
      const authorName = escapeHtml(originalMessage.display_name);
      let contentSnippet;
      if (originalMessage.is_deleted) {
        contentSnippet = '<i>此消息已被撤回</i>';
      } else {
        contentSnippet = escapeHtml(originalMessage.content.slice(0, 100));
      }
      replyHeaderHtml = `<div class="reply-header" data-jump-to-id="${originalMessage.id}"><img src="${authorAvatar}" alt="" class="reply-avatar"/> <strong class="reply-author">${authorName}</strong> <span class="reply-content">${contentSnippet}</span></div>`;
    }
  }

  return {
    id: row.id,
    userId: row.user_id,
    author: row.display_name,
    avatarUrl: buildAvatarUrl(row),
    text,
    html: replyHeaderHtml + renderMarkdown(text, mentionMap),
    time: new Date(row.created_at).toISOString(),
    isDeleted: Boolean(row.is_deleted),
    replyToId: row.reply_to_id || null,
    mentions: [] // --- MODIFICATION: Ensure mentions array exists ---
  };
}

function buildAvatarUrl(user) {
  if (!user) return 'https://cravatar.cn/avatar?d=identicon&s=160';
  if (user.avatar_source === 'url' && user.avatar_url) {
    return user.avatar_url;
  }
  if (user.avatar_source === 'upload' && user.avatar_url) {
    return user.avatar_url;
  }
  const hash = crypto
    .createHash('md5')
    .update(String(user.email || '').trim().toLowerCase())
    .digest('hex');
  return `https://cravatar.cn/avatar/${hash}?s=160&d=identicon`;
}

function cleanupUploadedFile(file) {
  if (!file || !file.path) return;
  fs.promises.unlink(file.path).catch(() => {});
}

function cleanupStoredAvatar(storedUrl) {
  if (!storedUrl || !storedUrl.startsWith('/uploads/')) return;
  const fileName = path.basename(storedUrl);
  const filePath = path.join(uploadsDir, fileName);
  fs.promises.unlink(filePath).catch(() => {});
}

function renderVerificationPage(message, success) {
  const title = success ? '验证成功' : '验证失败';
  const accent = success
    ? 'linear-gradient(135deg,#10b981,#14b8a6)'
    : 'linear-gradient(135deg,#f97316,#ef4444)';
  const icon = success ? '✅' : '⚠️';
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${title} · 漫游聊天室</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: "Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif;
      background:
        radial-gradient(120% 120% at 15% -10%, rgba(37,99,235,0.18), transparent 60%),
        radial-gradient(120% 120% at 80% 0%, rgba(124,58,237,0.24), transparent 55%),
        #eef2ff;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 20px;
      color: #0f172a;
    }
    .card {
      width: min(480px, 100%);
      background: rgba(255,255,255,0.92);
      border-radius: 28px;
      box-shadow:
        0 32px 70px rgba(15,23,42,0.18),
        0 16px 30px rgba(79,70,229,0.12);
      backdrop-filter: blur(18px);
      overflow: hidden;
    }
    .banner {
      padding: 36px 40px;
      background: ${accent};
      color: #ffffff;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .content {
      padding: 36px 40px 40px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .emoji {
      font-size: 48px;
    }
    .message {
      font-size: 16px;
      line-height: 1.7;
      color: #334155;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    a.button {
      padding: 12px 20px;
      border-radius: 999px;
      text-decoration: none;
      color: #fff;
      font-weight: 600;
      background: linear-gradient(135deg,#2563eb,#7c3aed);
      box-shadow: 0 16px 32px rgba(79,70,229,0.28);
    }
    a.secondary {
      background: rgba(15,23,42,0.08);
      color: #0f172a;
      box-shadow: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="banner">${title}</div>
    <div class="content">
      <div class="emoji">${icon}</div>
      <div class="message">${message}</div>
      <div class="actions">
        <a class="button" href="/">进入聊天室</a>
        <a class="button secondary" href="/login.html">返回登录</a>
      </div>
    </div>
  </div>
</body>
</html>`.trim();
}

function buildRoster() {
  return Array.from(userSockets.keys())
    .map(id => db.getUserById(id))
    .filter(Boolean)
    .map(mapUserToClient)
    .sort((a, b) => {
      const nameA = (a.displayName || '').toLowerCase();
      const nameB = (b.displayName || '').toLowerCase();
      return nameA.localeCompare(nameB, 'zh-Hans');
    });
}

function extractMentions(text, senderId) {
  const regex = /@([^\s@]+)(?=\s|$)/g;
  const ids = [];
  const map = new Map();
  let match;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const user = db.getUserByDisplayName(name);
    if (user && user.id !== senderId && !map.has(name)) {
      map.set(name, user.id);
      ids.push(user.id);
    }
  }

  return { ids, map };
}

function parseConnectionMode(handshake) {
  const raw =
    (handshake.auth && handshake.auth.mode) ||
    (handshake.query && handshake.query.mode) ||
    '';
  return String(raw || '')
    .trim()
    .toLowerCase() === 'presence'
    ? 'presence'
    : 'chat';
}

function scheduleDeparture(userId) {
  if (disconnectTimers.has(userId)) return;
  const timer = setTimeout(() => {
    disconnectTimers.delete(userId);
    const socketsForUser = userSockets.get(userId);
    if (socketsForUser && socketsForUser.size > 0) {
      return;
    }
    userSockets.delete(userId);
    const latest = db.getUserById(userId);
    if (latest) {
      io.emit('system-message', `${latest.display_name} 离开了聊天`);
    }
    io.emit('roster-update', buildRoster());
    io.emit('online-count', userSockets.size);
  }, 3500);
  disconnectTimers.set(userId, timer);
}

function generateResetCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function formatStickerForClient(sticker) {
  return {
    id: sticker.id,
    description: sticker.description,
    previewUrl: sticker.preview_url,
    imageUrl: sticker.image_url,
    createdAt: sticker.created_at
  };
}

function generateFileCode() {
  let attempts = 0;
  do {
    let code = '';
    for (let i = 0; i < 8; i += 1) {
      const idx = crypto.randomInt(0, FILE_CODE_ALPHABET.length);
      code += FILE_CODE_ALPHABET[idx];
    }
    if (!db.getFileByCode(code)) {
      return code;
    }
    attempts += 1;
  } while (attempts < 5);
  const fallback = crypto.randomBytes(6).toString('hex').toUpperCase();
  return fallback.slice(0, 8);
}
function decodeOriginalName(name) {
  const value = typeof name === 'string' ? name : '';
  if (!value) return '';
  try {
    return Buffer.from(value, 'latin1').toString('utf8');
  } catch {
    return value;
  }
}
function sanitizeFileName(name) {
  const normalized = String(name || 'file').trim();
  const replaced = normalized
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 200);
  return replaced || 'file';
}

function buildObjectKey(userId, code, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  const safeStem = stem.replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 80) || 'file';
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '');
  const timestamp = Date.now();
  return `files/${userId}/${code}-${timestamp}-${safeStem}${safeExt}`;
}

function buildContentDisposition(fileName) {
  const asciiName = fileName.replace(/[^ -~]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

function formatFileExtension(name) {
  const ext = path.extname(name || '').toLowerCase().replace('.', '');
  if (!ext) return null;
  return ext;
}

function formatFileForClient(record, displayName) {
  return {
    code: record.code,
    fileName: record.file_name,
    size: record.size,
    contentType: record.content_type,
    createdAt: record.created_at,
    uploader: displayName || null,
    extension: formatFileExtension(record.file_name)
  };
}

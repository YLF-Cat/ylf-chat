const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
const storePath = path.join(dataDir, 'store.json');
const MAX_CUSTOM_STICKERS = 60;

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const defaultStore = {
  users: [],
  messages: [],
  files: [],
  nextUserId: 1,
  nextMessageId: 1,
  nextFileId: 1
};

let store = loadStore();
let saveTimer = null;

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalizedUsers = Array.isArray(parsed.users)
      ? parsed.users.map(normalizeUser)
      : [];
    return {
      ...defaultStore,
      ...parsed,
      users: normalizedUsers,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      files: Array.isArray(parsed.files)
        ? parsed.files.map(normalizeFile).filter(Boolean)
        : [],
      nextUserId: Number.isInteger(parsed.nextUserId) ? parsed.nextUserId : 1,
      nextMessageId: Number.isInteger(parsed.nextMessageId)
        ? parsed.nextMessageId
        : 1,
      nextFileId: Number.isInteger(parsed.nextFileId) ? parsed.nextFileId : 1
    };
  } catch {
    return { ...defaultStore };
  }
}

function normalizeUser(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: store ? store.nextUserId++ : 0,
      email: '',
      password_hash: '',
      display_name: '',
      avatar_source: 'gravatar',
      avatar_url: null,
      is_verified: 0,
      verification_token: null,
      verification_expires: null,
      reset_code_hash: null,
      reset_code_expires: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      custom_stickers: []
    };
  }
  const stickers = Array.isArray(raw.custom_stickers)
    ? raw.custom_stickers.map(normalizeSticker).filter(Boolean)
    : [];
  return {
    id: raw.id,
    email: raw.email,
    password_hash: raw.password_hash,
    display_name: raw.display_name,
    avatar_source: raw.avatar_source || 'gravatar',
    avatar_url: raw.avatar_url || null,
    is_verified: raw.is_verified ? 1 : 0,
    verification_token: raw.verification_token || null,
    verification_expires: raw.verification_expires || null,
    reset_code_hash: raw.reset_code_hash || null,
    reset_code_expires: raw.reset_code_expires || null,
    created_at: Number.isFinite(raw.created_at) ? raw.created_at : Date.now(),
    updated_at: Number.isFinite(raw.updated_at) ? raw.updated_at : Date.now(),
    custom_stickers: stickers
  };
}

function normalizeSticker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const description =
    typeof raw.description === 'string'
      ? raw.description.trim().slice(0, 120)
      : '';
  const preview =
    typeof raw.preview_url === 'string' ? raw.preview_url.trim() : '';
  const image =
    typeof raw.image_url === 'string' ? raw.image_url.trim() : '';
  if (!preview || !image) return null;
  return {
    id:
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : crypto.randomBytes(8).toString('hex'),
    description,
    preview_url: preview,
    image_url: image,
    created_at: Number.isFinite(raw.created_at) ? raw.created_at : Date.now()
  };
}

function normalizeFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code =
    typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : null;
  const objectKey =
    typeof raw.object_key === 'string' ? raw.object_key.trim() : null;
  const fileName =
    typeof raw.file_name === 'string'
      ? raw.file_name.trim().slice(0, 260)
      : '';
  if (!code || !objectKey || !fileName) {
    return null;
  }
  return {
    id: Number.isInteger(raw.id) ? raw.id : store.nextFileId++,
    user_id: raw.user_id,
    code,
    object_key: objectKey,
    file_name: fileName,
    size: Number.isFinite(raw.size) ? raw.size : 0,
    content_type: typeof raw.content_type === 'string' ? raw.content_type : 'application/octet-stream',
    created_at: Number.isFinite(raw.created_at) ? raw.created_at : Date.now()
  };
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.promises
      .writeFile(storePath, JSON.stringify(store, null, 2), 'utf8')
      .catch(err => console.error('[db] failed to persist store:', err));
  }, 50);
}

function cloneSticker(sticker) {
  return {
    id: sticker.id,
    description: sticker.description,
    preview_url: sticker.preview_url,
    image_url: sticker.image_url,
    created_at: sticker.created_at
  };
}

function cloneFile(file) {
  if (!file) return null;
  return {
    id: file.id,
    user_id: file.user_id,
    code: file.code,
    object_key: file.object_key,
    file_name: file.file_name,
    size: file.size,
    content_type: file.content_type,
    created_at: file.created_at
  };
}

function cloneUser(user) {
  if (!user) return null;
  return {
    ...user,
    custom_stickers: Array.isArray(user.custom_stickers)
      ? user.custom_stickers.map(cloneSticker)
      : []
  };
}

function createUser(data) {
  const timestamp = Date.now();
  const user = {
    id: store.nextUserId++,
    email: data.email,
    password_hash: data.password_hash,
    display_name: data.display_name,
    avatar_source: data.avatar_source || 'gravatar',
    avatar_url: data.avatar_url || null,
    is_verified: data.is_verified ? 1 : 0,
    verification_token: data.verification_token || null,
    verification_expires: data.verification_expires || null,
    reset_code_hash: data.reset_code_hash || null,
    reset_code_expires: data.reset_code_expires || null,
    created_at: timestamp,
    updated_at: timestamp,
    custom_stickers: Array.isArray(data.custom_stickers)
      ? data.custom_stickers.map(normalizeSticker).filter(Boolean)
      : []
  };
  store.users.push(user);
  scheduleSave();
  return cloneUser(user);
}

function getUserByEmail(email) {
  return cloneUser(store.users.find(u => u.email === email));
}

function getUserById(id) {
  return cloneUser(store.users.find(u => u.id === id));
}

function updateUserProfile({ id, displayName, avatarSource, avatarUrl }) {
  const user = store.users.find(u => u.id === id);
  if (!user) return { changes: 0 };
  user.display_name = displayName;
  user.avatar_source = avatarSource || 'gravatar';
  user.avatar_url = avatarUrl || null;
  user.updated_at = Date.now();
  scheduleSave();
  return { changes: 1 };
}

function updateUserVerification({ id, isVerified, token, expires }) {
  const user = store.users.find(u => u.id === id);
  if (!user) return { changes: 0 };
  user.is_verified = isVerified ? 1 : 0;
  user.verification_token = token || null;
  user.verification_expires = expires || null;
  user.updated_at = Date.now();
  scheduleSave();
  return { changes: 1 };
}

function updateUserPassword({ id, passwordHash }) {
  const user = store.users.find(u => u.id === id);
  if (!user) return { changes: 0 };
  user.password_hash = passwordHash;
  user.updated_at = Date.now();
  scheduleSave();
  return { changes: 1 };
}

function setPasswordResetCode({ id, codeHash, expires }) {
  const user = store.users.find(u => u.id === id);
  if (!user) return { changes: 0 };
  user.reset_code_hash = codeHash;
  user.reset_code_expires = expires;
  user.updated_at = Date.now();
  scheduleSave();
  return { changes: 1 };
}

function clearPasswordResetCode(id) {
  const user = store.users.find(u => u.id === id);
  if (!user) return { changes: 0 };
  user.reset_code_hash = null;
  user.reset_code_expires = null;
  user.updated_at = Date.now();
  scheduleSave();
  return { changes: 1 };
}

function verifyUserByToken(token) {
  const user = store.users.find(u => u.verification_token === token);
  if (!user) {
    return { success: false, reason: 'not_found' };
  }
  if (user.is_verified) {
    return { success: true, already: true, user: cloneUser(user) };
  }
  if (user.verification_expires && user.verification_expires < Date.now()) {
    return { success: false, reason: 'expired', user: cloneUser(user) };
  }
  user.is_verified = 1;
  user.verification_token = null;
  user.verification_expires = null;
  user.updated_at = Date.now();
  scheduleSave();
  return { success: true, user: cloneUser(user) };
}

function saveMessage(userId, content, createdAt, replyToId) {
  const message = {
    id: store.nextMessageId++,
    user_id: userId,
    content,
    created_at: createdAt,
    reply_to_id: replyToId || null,
    is_deleted: 0
  };
  store.messages.push(message);
  scheduleSave();
  return { ...message };
}

function deleteMessage(messageId, requestingUserId) {
  const message = store.messages.find(m => m.id === messageId);
  if (!message) {
    return { success: false, reason: 'not_found' };
  }
  if (message.user_id !== requestingUserId) {
    return { success: false, reason: 'permission_denied' };
  }
  if (message.is_deleted) {
    return { success: true, already: true };
  }
  message.is_deleted = 1;
  scheduleSave();
  return { success: true };
}

function getMessageById(id) {
  const message = store.messages.find(m => m.id === id);
  if (!message) return null;
  const user = store.users.find(u => u.id === message.user_id);
  return {
    ...message,
    display_name: user ? user.display_name : '未知用户',
    email: user ? user.email : '',
    avatar_source: user ? user.avatar_source : 'gravatar',
    avatar_url: user ? user.avatar_url : null
  };
}

function getUserByDisplayName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!value) return null;
  const match = store.users.find(u => {
    const display = String(u.display_name || '').trim().toLowerCase();
    return display === value;
  });
  return cloneUser(match);
}

function getMessagesPage(limit, beforeId) {
  const take = Math.max(0, Number(limit) || 0);
  if (!take) return [];
  let filtered = store.messages;
  if (Number.isInteger(beforeId)) {
    filtered = filtered.filter(msg => msg.id < beforeId);
  }
  const slice = filtered.slice(-take);
  return slice
    .map(msg => {
      const user = store.users.find(u => u.id === msg.user_id);
      if (!user && msg.user_id != null) return null;
      return {
        id: msg.id,
        user_id: msg.user_id,
        content: msg.content,
        created_at: msg.created_at,
        display_name: user ? user.display_name : '系统消息',
        email: user ? user.email : '',
        avatar_source: user ? user.avatar_source : 'gravatar',
        avatar_url: user ? user.avatar_url : null,
        is_deleted: msg.is_deleted,
        reply_to_id: msg.reply_to_id
      };
    })
    .filter(Boolean);
}

function getRecentMessages(limit) {
  return getMessagesPage(limit);
}

function getUserStickers(userId) {
  const user = store.users.find(u => u.id === userId);
  if (!user || !Array.isArray(user.custom_stickers)) return [];
  return user.custom_stickers.map(cloneSticker);
}

function addUserSticker({ id, description, previewUrl, imageUrl }) {
  const user = store.users.find(u => u.id === id);
  if (!user) return { success: false, reason: 'not_found' };
  if (!Array.isArray(user.custom_stickers)) {
    user.custom_stickers = [];
  }
  if (user.custom_stickers.length >= MAX_CUSTOM_STICKERS) {
    return { success: false, reason: 'limit' };
  }
  const sticker = {
    id: crypto.randomBytes(8).toString('hex'),
    description,
    preview_url: previewUrl,
    image_url: imageUrl,
    created_at: Date.now()
  };
  user.custom_stickers.push(sticker);
  user.updated_at = Date.now();
  scheduleSave();
  return {
    success: true,
    sticker: cloneSticker(sticker),
    stickers: user.custom_stickers.map(cloneSticker)
  };
}

function removeUserSticker({ id, stickerId }) {
  const user = store.users.find(u => u.id === id);
  if (!user || !Array.isArray(user.custom_stickers)) {
    return { success: false, reason: 'not_found' };
  }
  const index = user.custom_stickers.findIndex(st => st.id === stickerId);
  if (index === -1) {
    return { success: false, reason: 'not_found' };
  }
  user.custom_stickers.splice(index, 1);
  user.updated_at = Date.now();
  scheduleSave();
  return { success: true };
}

function saveFileRecord({ userId, code, objectKey, fileName, size, contentType }) {
  const record = {
    id: store.nextFileId++,
    user_id: userId,
    code: String(code || '').trim().toUpperCase(),
    object_key: objectKey,
    file_name: fileName,
    size: size || 0,
    content_type: contentType || 'application/octet-stream',
    created_at: Date.now()
  };
  store.files.push(record);
  scheduleSave();
  return cloneFile(record);
}

function getFileByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  return cloneFile(store.files.find(file => file.code === normalized));
}

function getFilesByUser(userId) {
  return store.files
    .filter(file => file.user_id === userId)
    .sort((a, b) => b.created_at - a.created_at)
    .map(cloneFile);
}

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  updateUserProfile,
  updateUserVerification,
  updateUserPassword,
  setPasswordResetCode,
  clearPasswordResetCode,
  verifyUserByToken,
  saveMessage,
  deleteMessage,
  getMessageById,
  getUserByDisplayName,
  getMessagesPage,
  getRecentMessages,
  getUserStickers,
  addUserSticker,
  removeUserSticker,
  saveFileRecord,
  getFileByCode,
  getFilesByUser
};

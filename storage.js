const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let clientCache = null;
let configCache = null;
let configLoaded = false;

function readConfigFile() {
  if (configLoaded) {
    return configCache;
  }
  configLoaded = true;
  const configPath = path.join(__dirname, 'config', 'r2.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    configCache = JSON.parse(raw);
  } catch {
    configCache = null;
  }
  return configCache;
}

function resolveConfig() {
  const fileConfig = readConfigFile() || {};
  const accountId =
    process.env.R2_ACCOUNT_ID || process.env.CF_R2_ACCOUNT_ID || fileConfig.accountId || '';
  const accessKeyId =
    process.env.R2_ACCESS_KEY_ID || process.env.CF_R2_ACCESS_KEY_ID || fileConfig.accessKeyId || '';
  const secretAccessKey =
    process.env.R2_SECRET_ACCESS_KEY ||
    process.env.CF_R2_SECRET_ACCESS_KEY ||
    fileConfig.secretAccessKey ||
    '';
  const bucket = process.env.R2_BUCKET || fileConfig.bucket || '';
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || fileConfig.publicBaseUrl || '';

  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

function isConfigured() {
  const cfg = resolveConfig();
  return Boolean(cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket);
}

function getClient() {
  if (!isConfigured()) {
    return null;
  }
  if (clientCache) {
    return clientCache;
  }
  const cfg = resolveConfig();
  clientCache = {
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey
      }
    }),
    bucket: cfg.bucket,
    publicBaseUrl: cfg.publicBaseUrl || ''
  };
  return clientCache;
}

async function uploadObject({ key, body, contentType, contentDisposition }) {
  const ctx = getClient();
  if (!ctx) {
    throw new Error(
      'R2 对象存储未配置，请在 config/r2.json 或环境变量中填写账号、密钥和桶名。'
    );
  }
  const command = new PutObjectCommand({
    Bucket: ctx.bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    ContentDisposition: contentDisposition || undefined,
    CacheControl: 'max-age=31536000, immutable'
  });
  await ctx.client.send(command);
  return { key };
}

async function createPresignedUrl(key, expiresIn = 3600) {
  const ctx = getClient();
  if (!ctx) {
    throw new Error('R2 对象存储未配置。');
  }
  const command = new GetObjectCommand({
    Bucket: ctx.bucket,
    Key: key
  });
  const url = await getSignedUrl(ctx.client, command, { expiresIn });
  return { url, expiresIn };
}

module.exports = {
  isConfigured,
  uploadObject,
  createPresignedUrl
};

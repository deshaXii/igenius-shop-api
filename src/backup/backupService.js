// src/backup/backupService.js
"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const zlib = require("zlib");
const mongoose = require("mongoose");

// ⬅️ على Vercel نكتب في /tmp فقط
const IS_SERVERLESS =
  !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const BACKUP_DIR =
  process.env.BACKUP_DIR ||
  (IS_SERVERLESS ? "/tmp/backups" : path.join(process.cwd(), "backups"));
const DEFAULT_LIMIT_MB = Number(process.env.DB_FREE_TIER_MB || 512);

// Model بسيط لتسجيل آخر نسخة
const BackupMeta = mongoose.model(
  "BackupMeta",
  new mongoose.Schema(
    {
      _id: { type: String, default: "singleton" },
      lastBackupAt: Date,
      fileKey: String, // مفتاح الملف على التخزين (S3 …)
      fileSize: Number, // بايت
      storage: String, // s3 | local | none
      method: String, // mongodump | json
    },
    { timestamps: true }
  )
);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    "-" +
    pad(d.getMinutes()) +
    "-" +
    pad(d.getSeconds())
  );
}
function round(n, d = 2) {
  return Math.round(n * 10 ** d) / 10 ** d;
}

async function backupToBuffer() {
  const db = mongoose.connection.db;
  const cols = await db.listCollections().toArray();
  const dump = {};
  for (const c of cols) {
    const name = c.name;
    const docs = await db.collection(name).find({}).toArray();
    dump[name] = docs;
  }
  const json = Buffer.from(JSON.stringify(dump));
  const gz = zlib.gzipSync(json);
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const filename = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(
    d.getSeconds()
  )}.json.gz`;
  return { buffer: gz, filename, mime: "application/gzip" };
}

async function getDbStats() {
  const db = mongoose.connection.db;
  const stats = await db.command({ dbStats: 1, scale: 1024 * 1024 });
  const dataSizeMB = round(stats.dataSize || 0);
  const storageSizeMB = round(stats.storageSize || 0);
  const indexSizeMB = round(stats.indexSize || 0);
  const totalSizeMB = round(storageSizeMB + indexSizeMB);
  const limitMB = DEFAULT_LIMIT_MB;
  const usagePercent = round((totalSizeMB / limitMB) * 100, 1);
  return {
    dataSizeMB,
    storageSizeMB,
    indexSizeMB,
    totalSizeMB,
    limitMB,
    usagePercent,
  };
}

// ========== رفع إلى S3 (اختياري) ==========
async function uploadToS3(localPath, filename) {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION || "auto";
  const endpoint = process.env.S3_ENDPOINT || undefined; // لـ R2 ضع endpoint
  const prefix = (process.env.BACKUP_PREFIX || "db-backups/").replace(
    /^\/+|\/+$/g,
    ""
  );

  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: !!endpoint, // مهم لـ R2
    credentials: { accessKeyId, secretAccessKey },
  });

  const key = `${prefix}/${filename}`;
  const body = fs.createReadStream(localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
    })
  );
  const stat = await fsp.stat(localPath);
  return { key, size: stat.size };
}

// ========== إنشاء النسخة ==========
async function backupWithMongodump(uri) {
  ensureDirSync(BACKUP_DIR);
  const outFile = path.join(BACKUP_DIR, `${ts()}.archive.gz`);
  return new Promise((resolve, reject) => {
    const args = ["--uri", uri, "--gzip", "--archive=" + outFile];
    const ps = spawn("mongodump", args, { stdio: "inherit" });
    ps.on("error", (err) => reject(err));
    ps.on("exit", (code) => {
      if (code === 0)
        resolve({
          file: path.basename(outFile),
          localPath: outFile,
          method: "mongodump",
        });
      else reject(new Error("mongodump failed with code " + code));
    });
  });
}

async function backupWithJsonDump() {
  ensureDirSync(BACKUP_DIR);
  const db = mongoose.connection.db;
  const cols = await db.listCollections().toArray();
  const obj = {};
  for (const c of cols) {
    const name = c.name;
    const docs = await db.collection(name).find({}).toArray();
    obj[name] = docs;
  }
  const json = Buffer.from(JSON.stringify(obj));
  const gz = zlib.gzipSync(json);
  const file = `${ts()}.json.gz`;
  const localPath = path.join(BACKUP_DIR, file);
  await fsp.writeFile(localPath, gz);
  return { file, localPath, method: "json" };
}

async function runBackupNow() {
  const uri =
    process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  ensureDirSync(BACKUP_DIR);

  let result;
  try {
    // على Vercel الغالب مفيش mongodump → هيقع ونرجع JSON
    result = await backupWithMongodump(uri);
  } catch (e) {
    console.warn(
      "[backup] mongodump unavailable, fallback to JSON:",
      e.message
    );
    result = await backupWithJsonDump();
  }

  // ارفع لو S3 متاح
  let storage = "local";
  let fileKey = null;
  let fileSize = (await fsp.stat(result.localPath)).size;

  try {
    const uploaded = await uploadToS3(result.localPath, result.file);
    if (uploaded) {
      storage = "s3";
      fileKey = uploaded.key;
      fileSize = uploaded.size;
      // نظّف الملف المحلي المؤقّت
      try {
        await fsp.unlink(result.localPath);
      } catch {}
    } else if (IS_SERVERLESS) {
      // لو سيرفرلس ومافيش S3، ملف /tmp هيضيع بعد انتهاء التنفيذ
      storage = "none";
    }
  } catch (e) {
    console.error("[backup] S3 upload failed:", e);
    if (IS_SERVERLESS) storage = "none";
  }

  // سجل آخر نسخة في DB بدل ملف .last-backup.json
  await BackupMeta.findByIdAndUpdate(
    "singleton",
    {
      lastBackupAt: new Date(),
      fileKey: fileKey || result.file,
      fileSize,
      storage,
      method: result.method,
    },
    { upsert: true, new: true }
  );

  const stats = await getDbStats();
  return {
    ok: true,
    file: fileKey || result.file,
    storage,
    method: result.method,
    stats,
    at: new Date().toISOString(),
  };
}

async function readLastMeta() {
  const doc = await BackupMeta.findById("singleton").lean();
  return (
    doc || {
      lastBackupAt: null,
      fileKey: null,
      fileSize: null,
      storage: "none",
      method: null,
    }
  );
}

module.exports = {
  BACKUP_DIR,
  backupToBuffer,
  runBackupNow,
  readLastMeta,
  getDbStats,
};

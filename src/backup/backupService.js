// src/backup/backupService.js
"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const zlib = require("zlib");
const mongoose = require("mongoose");

// Restore/Backup helpers
const bcrypt = require("bcryptjs");
const User = require("../models/User.model");
const { EJSON, ObjectId } = require("bson");

// ⬅️ على Vercel نكتب في /tmp فقط
const IS_SERVERLESS =
  !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const BACKUP_DIR =
  process.env.BACKUP_DIR ||
  (IS_SERVERLESS ? "/tmp/backups" : path.join(process.cwd(), "backups"));

const DEFAULT_LIMIT_MB = Number(process.env.DB_FREE_TIER_MB || 512);
const DEFAULT_MAX_UPLOAD_MB = Number(process.env.BACKUP_MAX_UPLOAD_MB || 50);

// Model بسيط لتسجيل آخر نسخة (منع OverwriteModelError في بعض البيئات)
const BackupMeta =
  mongoose.models.BackupMeta ||
  mongoose.model(
    "BackupMeta",
    new mongoose.Schema(
      {
        _id: { type: String, default: "singleton" },
        lastBackupAt: Date,
        fileKey: String,
        fileSize: Number, // bytes
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

function isValidCollectionName(name) {
  if (!name || typeof name !== "string") return false;
  if (!/^[\w.\-]+$/.test(name)) return false;
  if (name.startsWith("system.")) return false;
  return true;
}

function isHex24(v) {
  return typeof v === "string" && /^[a-fA-F0-9]{24}$/.test(v);
}

// تحويل محافظ للنسخ القديمة (JSON عادي): فقط _id و *Id و *_id
function coerceIdsDeep(value, keyHint = "") {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => coerceIdsDeep(v, keyHint));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = coerceIdsDeep(v, k);
    return out;
  }

  const key = String(keyHint || "");
  const shouldConvert = key === "_id" || key.endsWith("_id") || key.endsWith("Id");
  if (shouldConvert && isHex24(value)) {
    try {
      return new ObjectId(value);
    } catch {
      return value;
    }
  }
  return value;
}

// ====== Seed Admin helper (Emergency admin) ======
function fullAdminPerms() {
  return {
    addRepair: true,
    editRepair: true,
    deleteRepair: true,
    receiveDevice: true,
    accessAccounts: true,
    settings: true,
    adminOverride: true,
  };
}

async function ensureSeedAdmin({ resetPassword = false } = {}) {
  const email = (process.env.ADMIN_EMAIL || "admin@admin.local").toLowerCase().trim();
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const password = String(process.env.ADMIN_PASSWORD || "adminPassword!#");

  const filter = { $or: [{ email }, { username }] };
  const existing = await User.findOne(filter).lean();

  const perms = fullAdminPerms();

  if (existing) {
    const $set = {
      role: "admin",
      isSeedAdmin: true,
      permissions: { ...(existing.permissions || {}), ...perms },
      perms: { ...(existing.perms || {}), ...perms },
    };

    if (resetPassword) {
      $set.password = await bcrypt.hash(password, 10);
    }

    const updated = await User.findOneAndUpdate(
      { _id: existing._id },
      { $set },
      { new: true }
    ).lean();

    return {
      ensured: true,
      created: false,
      resetPassword: !!resetPassword,
      email: updated?.email,
      username: updated?.username,
      id: updated?._id,
    };
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const doc = await User.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        name: "Administrator",
        email,
        username,
        role: "admin",
        isSeedAdmin: true,
        permissions: perms,
        perms,
        password: hashedPassword,
        createdAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    ensured: true,
    created: true,
    resetPassword: false,
    email: doc?.email,
    username: doc?.username,
    id: doc?._id,
  };
}

// ====== Backup to Buffer (EJSON) ======
async function backupToBuffer() {
  const db = mongoose.connection.db;
  const cols = await db.listCollections().toArray();
  const dump = {};

  for (const c of cols) {
    const name = c.name;
    if (!isValidCollectionName(name)) continue;

    const docs = await db.collection(name).find({}).toArray();
    dump[name] = docs;
  }

  const text = EJSON.stringify(dump, { relaxed: false });
  const gz = zlib.gzipSync(Buffer.from(text, "utf8"));

  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const filename = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(
    d.getSeconds()
  )}.json.gz`;

  return { buffer: gz, filename, mime: "application/gzip" };
}

// ✅ dbStats بدون scale (علشان مايبقاش 0)
async function getDbStats() {
  const db = mongoose.connection.db;
  const stats = await db.command({ dbStats: 1 });

  const MB = 1024 * 1024;
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  let indexBytes = 0;
  if (typeof stats.indexSize === "number") indexBytes = toNum(stats.indexSize);
  else if (stats.indexSizes && typeof stats.indexSizes === "object") {
    indexBytes = Object.values(stats.indexSizes).reduce((a, b) => a + toNum(b), 0);
  } else indexBytes = toNum(stats.indexSize);

  const dataBytes = toNum(stats.dataSize);
  const storageBytes = toNum(stats.storageSize);
  const totalBytes = storageBytes + indexBytes;

  const limitMB = DEFAULT_LIMIT_MB;
  const limitBytes = limitMB * MB;
  const usagePercent = limitBytes > 0 ? (totalBytes / limitBytes) * 100 : 0;

  return {
    dataSizeBytes: dataBytes,
    storageSizeBytes: storageBytes,
    indexSizeBytes: indexBytes,
    totalSizeBytes: totalBytes,

    dataSizeMB: round(dataBytes / MB, 4),
    storageSizeMB: round(storageBytes / MB, 4),
    indexSizeMB: round(indexBytes / MB, 4),
    totalSizeMB: round(totalBytes / MB, 4),

    limitMB,
    usagePercent: round(usagePercent, 2),
  };
}

// ========== رفع إلى S3 (اختياري) ==========
async function uploadToS3(localPath, filename) {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION || "auto";
  const endpoint = process.env.S3_ENDPOINT || undefined;
  const prefix = (process.env.BACKUP_PREFIX || "db-backups/").replace(
    /^\/+|\/+$/g,
    ""
  );

  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: !!endpoint,
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
    if (!isValidCollectionName(name)) continue;

    const docs = await db.collection(name).find({}).toArray();
    obj[name] = docs;
  }

  const text = EJSON.stringify(obj, { relaxed: false });
  const gz = zlib.gzipSync(Buffer.from(text, "utf8"));

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
    result = await backupWithMongodump(uri);
  } catch (e) {
    console.warn("[backup] mongodump unavailable, fallback to JSON:", e.message);
    result = await backupWithJsonDump();
  }

  let storage = "local";
  let fileKey = null;
  let fileSize = (await fsp.stat(result.localPath)).size;

  try {
    const uploaded = await uploadToS3(result.localPath, result.file);
    if (uploaded) {
      storage = "s3";
      fileKey = uploaded.key;
      fileSize = uploaded.size;
      try {
        await fsp.unlink(result.localPath);
      } catch {}
    } else if (IS_SERVERLESS) {
      storage = "none";
    }
  } catch (e) {
    console.error("[backup] S3 upload failed:", e);
    if (IS_SERVERLESS) storage = "none";
  }

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

// ========== Restore من ملف Backup (json / json.gz) ==========
async function restoreFromBackupBuffer(
  fileBuffer,
  filename,
  { replace = true, skipCollections = [] } = {}
) {
  if (!Buffer.isBuffer(fileBuffer)) throw new Error("Invalid file buffer");
  if (!filename || typeof filename !== "string") filename = "backup.json.gz";

  const maxBytes = DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
  if (fileBuffer.length > maxBytes) {
    throw new Error(`File too large (> ${DEFAULT_MAX_UPLOAD_MB}MB)`);
  }

  const skip = new Set(
    (skipCollections || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
  );

  const isGz = filename.toLowerCase().endsWith(".gz");
  let raw = fileBuffer;
  if (isGz) raw = zlib.gunzipSync(fileBuffer);

  const text = raw.toString("utf8");

  let parsed;
  try {
    parsed = EJSON.parse(text, { relaxed: false });
  } catch {
    parsed = JSON.parse(text);
    parsed = coerceIdsDeep(parsed);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid backup format (expected object of collections)");
  }

  const db = mongoose.connection.db;
  const results = [];
  let totalInserted = 0;
  let totalDeleted = 0;

  for (const [colName, docs] of Object.entries(parsed)) {
    if (!isValidCollectionName(colName)) continue;
    if (skip.has(colName.toLowerCase())) continue;
    if (!Array.isArray(docs)) continue;

    const col = db.collection(colName);

    let deleted = 0;
    if (replace) {
      const delRes = await col.deleteMany({});
      deleted = delRes?.deletedCount || 0;
      totalDeleted += deleted;
    }

    let inserted = 0;
    if (docs.length) {
      try {
        const insRes = await col.insertMany(docs, { ordered: false });
        inserted = insRes?.insertedCount || 0;
      } catch (e) {
        inserted = e?.result?.result?.nInserted || e?.result?.insertedCount || 0;
      }
      totalInserted += inserted;
    }

    results.push({
      name: colName,
      docsInFile: docs.length,
      deleted,
      inserted,
    });
  }

  return {
    ok: true,
    replace,
    filename,
    skippedCollections: Array.from(skip),
    collections: results,
    totals: {
      collections: results.length,
      deleted: totalDeleted,
      inserted: totalInserted,
    },
    at: new Date().toISOString(),
  };
}

module.exports = {
  BACKUP_DIR,
  backupToBuffer,
  runBackupNow,
  readLastMeta,
  getDbStats,
  restoreFromBackupBuffer,
  ensureSeedAdmin,
};

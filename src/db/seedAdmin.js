"use strict";

/**
 * Safe seed for primary Admin (DB-consistent):
 * - Uses the SAME DB as your app (via MONGO_URI including db OR MONGO_DB_NAME).
 * - Upserts seed admin without double-hash (manual bcrypt + findOneAndUpdate).
 * - Grants full admin perms.
 */

require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User.model");

/* ---- Build Mongo URI to EXACTLY match your app ---- */
function resolveMongoUri() {
  // لو عندك URI كامل بـ DB اسمها محدد (المفضل)، استخدمه
  const raw =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/";

  // اسم الـDB: لو مش متحدد في الـURI، هنستخدم MONGO_DB_NAME (افتراضي = aqsa)
  const dbName = process.env.MONGO_DB_NAME || "aqsa";

  // لو الـURI بينتهي بـ "/" ومفيهوش اسم DB → ألحِق dbName
  if (raw.endsWith("/")) return raw + dbName;

  // لو الـURI فيه DB بالفعل (…/mydb) سيبه زي ما هو
  const hasDb = /mongodb(\+srv)?:\/\/[^/]+\/[^/?#]+/.test(raw);
  if (hasDb) return raw;

  // غير كده، زوّد "/" + dbName
  return raw + "/" + dbName;
}
const MONGO_URI = resolveMongoUri();

/* ---- Full admin permissions ---- */
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

/* ---- Upsert / Ensure seed admin ---- */
async function ensureAdminFromEnv() {
  const email = (process.env.ADMIN_EMAIL || "admin@admin.local").toLowerCase();
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const password = process.env.ADMIN_PASSWORD || "adminPassword!#";

  const filter = { $or: [{ email }, { username }] };

  // موجود؟
  const existing = await User.findOne(filter).lean();
  if (existing) {
    if (existing.isSeedAdmin) {
      console.log("👤 Seed admin already exists:", {
        id: existing._id,
        email: existing.email,
        username: existing.username,
      });
      return existing;
    }

    // Upgrade آمن — بدون تغيير الباسورد
    const updated = await User.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          role: "admin",
          isSeedAdmin: true,
          permissions: { ...(existing.permissions || {}), ...fullAdminPerms() },
          perms: { ...(existing.perms || {}), ...fullAdminPerms() },
        },
      },
      { new: true }
    ).lean();

    console.log("🔼 Upgraded existing user to seed admin:", {
      id: updated._id,
      email: updated.email,
      username: updated.username,
    });
    return updated;
  }

  // إنشاء جديد (bcrypt يدوي + upsert لتفادي pre-save)
  console.log('password ', password);
  
  const hashedPassword = await bcrypt.hash(String(password), 10);

  const doc = await User.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        name: "Administrator",
        email,
        username,
        role: "admin",
        isSeedAdmin: true,
        permissions: fullAdminPerms(),
        perms: fullAdminPerms(),
        password: hashedPassword,
        createdAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  console.log("🌱 Seed admin created:", {
    id: doc._id,
    email: doc.email,
    username: doc.username,
  });

  return doc;
}

/* ---- Entrypoint ---- */
async function main() {
  try {
    console.log("🔌 Connecting to MongoDB…", MONGO_URI);
    await mongoose.connect(MONGO_URI, { autoIndex: true });
    console.log("✅ MongoDB connected.");

    await ensureAdminFromEnv();
  } catch (err) {
    if (err && err.code === 11000) {
      console.error("❗ Duplicate key (email/username) conflict.");
    }
    console.error(err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("🔒 MongoDB disconnected.");
  }
}

if (require.main === module) main();

module.exports = { ensureAdminFromEnv };

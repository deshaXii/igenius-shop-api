// src/db/connect.js
"use strict";

const mongoose = require("mongoose");

mongoose.set("strictQuery", true);
mongoose.set("bufferCommands", false);

// تحقق من اسم قاعدة البيانات فقط (مش الـ URI)
function validateDbName(name, source = "MONGO_DB_NAME/MONGODB_DB") {
  if (!name) return;
  // الممنوع: / \ . " (مسافة) $
  if (/[\/\\\.\s"\$]/.test(name)) {
    throw new Error(
      `Invalid Mongo database name "${name}" from ${source}. ` +
        `Database names cannot contain / \\ . " (space) or $.`
    );
  }
}

function maskUri(u) {
  try {
    const url = new URL(u);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return String(u || "").replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");
  }
}

// لو الـ URI يحتوي اسم DB (path بعد الدومين)
function extractDbFromUri(u) {
  const m = String(u || "").match(
    /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?\/]+)(?:\?|$)/i
  );
  return m ? m[1] : undefined;
}

async function connectDB() {
  // ندعم الاسمين تحسبًا: MONGO_URI ثم MONGODB_URI
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/aqsa";

  // اسم الـ DB من env (لو اتحدد) أو نسيبه undefined لو عايزين اللي في الـ URI
  const dbNameEnv =
    process.env.MONGO_DB_NAME || process.env.MONGODB_DB || undefined;
  if (dbNameEnv) validateDbName(dbNameEnv, "MONGO_DB_NAME/MONGODB_DB");

  // لو الـ URI نفسه فيه اسم DB (زي ...mongodb.net/aqsa) نتحقق منه بس ومش هنمرر dbName
  const dbFromUri = extractDbFromUri(uri);
  if (dbFromUri) validateDbName(dbFromUri, "MONGO_URI/MONGODB_URI");

  const opts = {
    ...(dbNameEnv ? { dbName: dbNameEnv } : {}), // لو محدد في env يغلّب
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
  };

  console.log("🗄️  Connecting Mongo:", {
    uri: maskUri(uri),
    usingDb: dbNameEnv || dbFromUri || "(driver default)",
  });

  await mongoose.connect(uri, opts);

  const c = mongoose.connection;
  console.log(`✅ Mongo connected: ${c.name} @ ${c.host}:${c.port || ""}`);

  c.on("disconnected", () => console.warn("⚠️ Mongo disconnected"));
  c.on("error", (err) => console.error("❌ Mongo error:", err));

  return c;
}

module.exports = connectDB;

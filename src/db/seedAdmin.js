// src/db/seedAdmin.js
"use strict";

const bcrypt = require("bcryptjs");
const User = require("../models/User.model");

async function ensureAdminFromEnv() {
  const email = (process.env.ADMIN_EMAIL || "admin@aqsa.local").toLowerCase();
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123";

  // لو موجود بالفعل، خلاص
  const exists = await User.findOne({
    $or: [{ email }, { username }, { role: "admin" }],
  });
  if (exists) {
    console.log(
      "👤 Admin exists:",
      exists.username || exists.email || exists._id
    );
    return exists;
  }

  const user = new User({
    name: "Administrator",
    email,
    username,
    role: "admin",
    permissions: { adminOverride: true },
    password, // حاول نسيب الـ pre-save يعمل هاش
  });

  // لو سكيمتك مفيهاش pre-save hash:
  if (!user.isModified || !user.isModified("password")) {
    if (!user.password?.startsWith("$2")) {
      user.password = await bcrypt.hash(String(password), 10);
    }
  }

  await user.save();
  console.log("✅ Admin created:", { username, email, password });
  return user;
}

module.exports = { ensureAdminFromEnv };

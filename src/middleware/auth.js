// src/middleware/auth.js
"use strict";

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User.model");

/* نفس مفاتيح الصلاحيات المستخدمة في المشروع */
const PERM_KEYS = [
  "accessAccounts",
  "addRepair",
  "editRepair",
  "deleteRepair",
  "receiveDevice",
  "settings",
  "adminOverride",
];

const toBool = (v) =>
  v === true ||
  v === 1 ||
  v === "1" ||
  v === "true" ||
  v === "on" ||
  v === "yes";

/* تطبيع الصلاحيات + توحيد (إضافة/استلام) + ترقية adminOverride = full allow */
function normalizePerms(doc) {
  const src = (doc && (doc.permissions || doc.perms || doc)) || {};
  const out = {};
  for (const k of PERM_KEYS) out[k] = toBool(src[k] ?? false);

  // توحيد الاستلام/الإضافة
  if (out.addRepair || out.receiveDevice) {
    out.addRepair = true;
    out.receiveDevice = true;
  }
  // أدمن شامل
  if (out.adminOverride) {
    for (const k of PERM_KEYS) out[k] = true;
  }
  return out;
}

module.exports = async function auth(req, res, next) {
  try {
    // 1) Authorization: Bearer xxx
    let token = "";
    const hdr = req.headers.authorization || req.headers.Authorization;
    if (hdr && /^Bearer\s+/i.test(hdr)) {
      token = hdr.replace(/^Bearer\s+/i, "").trim();
    }

    // 2) Cookie token
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    // 3) x-access-token / x-token
    if (!token) {
      const x =
        req.get("x-access-token") ||
        req.get("x-token") ||
        req.headers["x-access-token"] ||
        req.headers["x-token"];
      if (x) token = String(x).trim();
    }

    // 4) query ?token=
    if (!token && req.query && req.query.token) {
      token = String(req.query.token);
    }

    if (!token) return res.status(401).json({ message: "No token provided" });

    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret_change_me"
    );

    // دعم أكثر من اسم للحقل (بدون كسر الموجود)
    const uid = payload.id || payload._id || payload.userId || payload.sub;
    if (!uid) return res.status(401).json({ message: "Invalid token payload" });

    const uidStr = String(uid);

    // ✅ FIX: بحث مقاوم لكون _id String أو ObjectId (بدون casting من Mongoose)
    // استخدم native collection مباشرةً
    const usersCol = User.collection; // native mongodb collection تحت hood

    const or = [{ _id: uidStr }];

    // لو uid شكله ObjectId → جرّب كمان ObjectId
    if (mongoose.Types.ObjectId.isValid(uidStr)) {
      try {
        or.push({ _id: new mongoose.Types.ObjectId(uidStr) });
      } catch {}
    }

    // projection مطابق للـ select السابق
    const user = await usersCol.findOne(
      { $or: or },
      {
        projection: {
          role: 1,
          permissions: 1,
          perms: 1,
          isSeedAdmin: 1,
          name: 1,
          username: 1,
          email: 1,
          department: 1,
          password: 1,
        },
      }
    );

    if (!user) return res.status(401).json({ message: "User not found" });

    const perms = normalizePerms(user);

    req.user = {
      id: String(user._id),
      role: user.role,
      name: user.name,
      username: user.username,
      email: user.email,
      department: user.department || null,
      isSeedAdmin: !!user.isSeedAdmin,
      permissions: perms, // ← بعد التطبيع (adminOverride = كل الصلاحيات true)
    };

    next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};

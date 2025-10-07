// src/routes/auth.routes.js
"use strict";

const router = require("express").Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/User.model");

/* نفس مفاتيح/تطبيع الصلاحيات المستخدمة بالمشروع */
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
  v === true || v === 1 || v === "1" || v === "true" || v === "on" || v === "yes";

function normalizePerms(doc) {
  const src = (doc && (doc.permissions || doc.perms || doc)) || {};
  const out = {};
  for (const k of PERM_KEYS) out[k] = toBool(src[k] ?? false);

  if (out.addRepair || out.receiveDevice) {
    out.addRepair = true;
    out.receiveDevice = true;
  }
  if (out.adminOverride) {
    for (const k of PERM_KEYS) out[k] = true;
  }
  return out;
}

/* POST /api/auth/login */
router.post("/login", async (req, res) => {
  try {
    const rawUser = String(req.body.username || "").trim();
    const rawPass = String(req.body.password || "");

    if (!rawUser || !rawPass) {
      return res.status(400).json({ message: "الرجاء إدخال اسم المستخدم وكلمة المرور" });
    }

    // اسم مستخدم أو بريد—ابحث بأي منهم (case-insensitive)
    const q = {
      $or: [
        { username: rawUser },
        { email: rawUser.toLowerCase() },
      ],
    };

    // لو في احتمال اختلاف case لأسماء المستخدمين، نقدر نستخدم regex:
    // const q = { $or: [{ username: new RegExp(`^${rawUser}$`, "i") }, { email: rawUser.toLowerCase() }] };

    const user = await User.findOne(q)
      .select("name username email role password permissions perms isSeedAdmin department")
      .lean();

    if (!user) {
      return res.status(401).json({ message: "بيانات الدخول غير صحيحة" });
    }

    // قارن الباسورد المدخلة بالهاش المخزون
    const ok = await bcrypt.compare(rawPass, user.password);
    if (!ok) {
      return res.status(401).json({ message: "بيانات الدخول غير صحيحة" });
    }

    // جهّز التوكن + المستخدم للواجهة
    const tokenPayload = { id: String(user._id) };
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET || "dev_secret_change_me", {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    });

    const perms = normalizePerms(user);

    return res.json({
      token,
      user: {
        id: String(user._id),
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        department: user.department || null,
        isSeedAdmin: !!user.isSeedAdmin,
        permissions: perms,
      },
    });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ message: "تعذر تسجيل الدخول" });
  }
});

module.exports = router;

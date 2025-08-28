// src/api/auth.routes.js
"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User.model");

// helper: توليد توكن
function signToken(user) {
  const payload = { id: user._id, role: user.role };
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  const expiresIn = process.env.JWT_EXPIRES_IN || "1d";
  return jwt.sign(payload, secret, { expiresIn });
}

// sanitize
function toSafeUser(u) {
  const obj = u.toObject ? u.toObject() : u;
  delete obj.password;
  delete obj.passwordHash;
  return obj;
}

/**
 * POST /api/auth/login
 * يقبل identifier (email/username/phone) + password
 * أو يقبل { email,password } / { username,password } / { phone,password }
 */
router.post("/login", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res
        .status(503)
        .json({ message: "Database not connected. Try again shortly." });
    }

    const { identifier, email, username, phone, password } = req.body || {};

    const id = String(identifier || email || username || phone || "").trim();
    if (!id || !password) {
      return res
        .status(400)
        .json({
          message: "identifier/email/username/phone and password are required",
        });
    }

    const query = {
      $or: [{ email: id.toLowerCase() }, { username: id }, { phone: id }],
    };

    // لو password مخفي في السكيما بـ select: false، نجبر إظهاره
    let user = await User.findOne(query).select("+password +passwordHash");
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // مقارنة الباسورد: ادعم comparePassword أو bcrypt مباشرة
    let ok = false;
    if (typeof user.comparePassword === "function") {
      ok = await user.comparePassword(password);
    } else if (user.password) {
      ok = await bcrypt.compare(password, user.password);
    } else if (user.passwordHash) {
      ok = await bcrypt.compare(password, user.passwordHash);
    }

    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = signToken(user);
    const safeUser = toSafeUser(user);

    // لو عندك كوكيات JWT:
    if (String(process.env.AUTH_COOKIE || "").toLowerCase() === "true") {
      res.cookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: !!process.env.COOKIE_SECURE,
        maxAge: 24 * 60 * 60 * 1000,
      });
    }

    return res.json({ token, user: safeUser });
  } catch (e) {
    console.error("Login error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * (اختياري) إنشاء مستخدم — مفيد لو عايز تضيف فنيين من الباك إند
 * يفضل تحميه بصلاحيات لاحقًا
 */
router.post("/register", async (req, res) => {
  try {
    const { name, email, username, phone, password, role, permissions } =
      req.body || {};
    if (!password || !(email || username || phone)) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const exists = await User.findOne({
      $or: [{ email }, { username }, { phone }],
    });
    if (exists) return res.status(409).json({ message: "User already exists" });

    const user = new User({
      name: name || username || email || phone,
      email: email ? String(email).toLowerCase() : undefined,
      username,
      phone,
      role: role || "technician",
      permissions: permissions || {},
      password, // نعتمد على pre-save hook لو موجود، وإلا نحاول bcrypt في الأسفل
    });

    // لو السكيما ما عندهاش pre-save hash، اعمل هاش يدوي:
    if (!user.isModified || !user.isModified("password")) {
      // السكيما قد لا تملك isModified، فنضيف حماية:
      if (!user.passwordHash && !user.password?.startsWith("$2")) {
        user.password = await bcrypt.hash(String(password), 10);
      }
    }

    await user.save();
    return res.status(201).json(toSafeUser(user));
  } catch (e) {
    console.error("Register error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;

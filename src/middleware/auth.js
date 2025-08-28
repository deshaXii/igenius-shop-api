// src/middleware/auth.js
"use strict";

const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

module.exports = async function auth(req, res, next) {
  try {
    // 1) جرّب Authorization: Bearer xxx
    let token = "";
    const hdr = req.headers.authorization || req.headers.Authorization;
    if (hdr && /^Bearer\s+/i.test(hdr)) {
      token = hdr.replace(/^Bearer\s+/i, "").trim();
    }

    // 2) جرّب الكوكي (لو بتستخدمه)
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    // 3) جرّب query ?token=...
    if (!token && req.query && req.query.token) {
      token = String(req.query.token);
    }

    if (!token) return res.status(401).json({ message: "No token provided" });

    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret_change_me"
    );
    const uid = payload.id || payload._id;
    if (!uid) return res.status(401).json({ message: "Invalid token payload" });

    const user = await User.findById(uid).lean();
    if (!user) return res.status(401).json({ message: "User not found" });

    req.user = {
      id: String(user._id),
      role: user.role,
      permissions: user.permissions || {},
      name: user.name,
      username: user.username,
    };
    next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};

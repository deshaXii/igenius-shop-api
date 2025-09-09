"use strict";
const jwt = require("jsonwebtoken");

module.exports = function requireAuth(req, res, next) {
  try {
    // جرّب Authorization Bearer أولاً
    let token;
    const hdr = req.headers && req.headers.authorization;
    if (hdr && hdr.startsWith("Bearer ")) {
      token = hdr.slice(7);
    }
    // أو Cookie باسم "token" (لو أنت بتستعمله)
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // حط أقل معلومات نحتاجها
    req.user = {
      _id: payload.sub || payload.id || payload._id,
      role: payload.role || payload.r || (payload.isAdmin ? "admin" : "user"),
      isAdmin: !!payload.isAdmin || payload.role === "admin",
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

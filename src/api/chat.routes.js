// src/api/chat.routes.js
const express = require("express");
const router = express.Router();
const Message = require("../models/Message.model");
const Notification = require("../models/Notification.model");
const auth = require("../middleware/auth");

router.use(auth);

// Public: list recent
router.get("/public", async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : null;
  const q = { channel: "public" };
  if (since) q.createdAt = { $gt: since };
  const msgs = await Message.find(q)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("from", "name")
    .lean();
  res.json(msgs.reverse());
});

// Public: send
router.post("/public", async (req, res) => {
  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).json({ message: "Empty message" });
  const msg = await Message.create({
    channel: "public",
    from: req.user.id,
    content,
    recipients: [],
  });
  // إشعار للجميع؟ عادة لا — لكن يمكنك إشعار الأدمن فقط
  res.json(msg);
});

// DM: list with user
router.get("/dm/:userId", async (req, res) => {
  const other = req.params.userId;
  const msgs = await Message.find({
    channel: "dm",
    recipients: { $all: [req.user.id, other] },
  })
    .sort({ createdAt: 1 })
    .populate("from", "name")
    .lean();
  res.json(msgs);
});

// DM: send
router.post("/dm/:userId", async (req, res) => {
  const other = req.params.userId;
  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).json({ message: "Empty message" });

  const msg = await Message.create({
    channel: "dm",
    from: req.user.id,
    recipients: [req.user.id, other],
    content,
  });

  // إشعار للمستلم
  await Notification.create({
    user: other,
    type: "chat",
    message: "لديك رسالة خاصة جديدة",
    meta: { from: req.user.id },
  });

  res.json(msg);
});

module.exports = router;

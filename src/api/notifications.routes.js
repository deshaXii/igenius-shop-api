// src/api/notifications.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Notification = require("../models/Notification.model");

router.use(auth);

/* ---------- Helpers ---------- */
function unreadOrFilter() {
  return {
    $or: [
      { isRead: false },
      { read: false },
      { seen: false },
      // لو الحقول دي مش موجودة أصلاً نعتبرها غير مقروءة
      {
        $and: [
          { isRead: { $exists: false } },
          { read: { $exists: false } },
          { seen: { $exists: false } },
        ],
      },
    ],
  };
}

function readSet(read) {
  // read === true => علّم كمقروء + حدّد readAt
  // read === false => علّم كغير مقروء + امسح readAt
  return read
    ? { isRead: true, read: true, seen: true, readAt: new Date() }
    : { isRead: false, read: false, seen: false, readAt: null };
}

/* ---------- عدّاد غير المقروء ---------- */
// GET /api/notifications/unread-count
router.get("/unread-count", async (req, res) => {
  const filter = { user: req.user.id, ...unreadOrFilter() };
  const count = await Notification.countDocuments(filter);
  res.json({ count });
});

/* ---------- لستة الإشعارات (يدعم ?unread=true و limit/offset) ---------- */
// GET /api/notifications
router.get("/", async (req, res) => {
  try {
    const { unread, limit = 50, offset = 0 } = req.query;
    const filter = { user: req.user.id };
    if (String(unread) === "true") {
      Object.assign(filter, unreadOrFilter());
    }

    const items = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(Number(offset))
      .limit(Math.max(1, Math.min(200, Number(limit))))
      .lean();

    res.json(items);
  } catch (e) {
    console.error("notifications list error:", e);
    res.status(500).json({ message: "تعذر تحميل الإشعارات" });
  }
});

/* ---------- تعليم إشعار واحد مقروء/غير مقروء ---------- */
// PUT (متوافق قديمًا)
router.put("/:id/read", async (req, res) => {
  try {
    const read =
      req.body && typeof req.body.read === "boolean" ? req.body.read : true;
    const n = await Notification.findOne({
      _id: req.params.id,
      user: req.user.id,
    });
    if (!n) return res.status(404).json({ message: "Not found" });

    Object.assign(n, readSet(read));
    await n.save();
    res.json({ ok: true, notification: n.toObject() });
  } catch (e) {
    console.error("notification mark read (PUT) error:", e);
    res.status(500).json({ message: "تعذر تحديث حالة الإشعار" });
  }
});

// PATCH (المسار الجديد اللي بتستخدمه صفحة الجروبينج)
router.patch("/:id/read", async (req, res) => {
  try {
    const read =
      req.body && typeof req.body.read === "boolean" ? req.body.read : true;
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: readSet(read) },
      { new: true }
    ).lean();
    if (!n) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true, notification: n });
  } catch (e) {
    console.error("notification mark read (PATCH) error:", e);
    res.status(500).json({ message: "تعذر تحديث حالة الإشعار" });
  }
});

/* ---------- تعليم مجموعة إشعارات مقروء/غير مقروء (للجروبينج) ---------- */
// POST /api/notifications/mark-read  { ids: string[], read: boolean }
router.post("/mark-read", async (req, res) => {
  try {
    const { ids = [], read = true } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "لا توجد معرفات" });
    }
    const r = await Notification.updateMany(
      { _id: { $in: ids }, user: req.user.id },
      { $set: readSet(!!read) }
    );
    res.json({ ok: true, modified: r.modifiedCount ?? r.nModified ?? 0 });
  } catch (e) {
    console.error("notifications mark-read (batch) error:", e);
    res.status(500).json({ message: "تعذر تحديث الإشعارات" });
  }
});

/* ---------- تعليم الكل كمقروء (متوافق قديمًا) ---------- */
// PUT /api/notifications/mark-all-read
router.put("/mark-all-read", async (req, res) => {
  try {
    const filter = { user: req.user.id, ...unreadOrFilter() };
    const r = await Notification.updateMany(filter, { $set: readSet(true) });
    res.json({ ok: true, modified: r.modifiedCount ?? r.nModified ?? 0 });
  } catch (e) {
    console.error("notifications mark-all-read error:", e);
    res.status(500).json({ message: "تعذر تعليم الكل كمقروء" });
  }
});

/* ---------- مسح الإشعارات ---------- */
// DELETE /api/notifications/clear?all=true
// (الافتراضي) يمسح المقروء فقط
router.delete("/clear", async (req, res) => {
  try {
    const all = String(req.query.all || "").toLowerCase() === "true";
    const baseFilter = { user: req.user.id };

    const filter = all
      ? baseFilter
      : {
          ...baseFilter,
          $or: [{ isRead: true }, { read: true }, { seen: true }],
        };

    const r = await Notification.deleteMany(filter);
    res.json({ ok: true, deleted: r.deletedCount || 0 });
  } catch (e) {
    console.error("notifications clear error:", e);
    res.status(500).json({ message: "تعذر مسح الإشعارات" });
  }
});

module.exports = router;

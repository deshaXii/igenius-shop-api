"use strict";
const router = require("express").Router();
const Department = require("../models/Department.model");
const Technician = require("../models/User.model");
const requireAuth = require("../middleware/requireAuth");
const Repair = require("../models/Repair.model");

// نفترض إن auth middleware سابقًا بيحط req.user { _id, role }.
// دوال مساعدة بسيطة:
function ensureAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function isAdmin(u) {
  return u && (u.role === "admin" || u.isAdmin === true);
}

// هل المستخدم مراقب هذا القسم؟
async function isMonitorOf(userId, deptId) {
  const d = await Department.findById(deptId).select("monitor");
  return !!(d && d.monitor && d.monitor.toString() === String(userId));
}

// كل راوت هنا لازم يبقى Authenticated
router.use(requireAuth);

// GET /api/departments  => admin: الكل، monitor: قسمه فقط
router.get("/", async (req, res, next) => {
  try {
    let query = {};
    if (!isAdmin(req.user)) {
      // لو هو مراقب لقسم ما — رجّع قسمه فقط
      const mine = await Department.findOne({ monitor: req.user._id }).select(
        "_id"
      );
      if (!mine) return res.json([]); // مش أدمن ولا مراقب
      query = { _id: mine._id };
    }
    const list = await Department.find(query)
      .populate("monitor", "username name email")
      .sort({ createdAt: -1 })
      .lean();

    // احسب عدد الفنيين بكل قسم
    const ids = list.map((d) => d._id);
    const counts = await Technician.aggregate([
      { $match: { department: { $in: ids } } },
      { $group: { _id: "$department", c: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((x) => [String(x._id), x.c]));
    const result = list.map((d) => ({
      ...d,
      techCount: countMap.get(String(d._id)) || 0,
    }));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// POST /api/departments  (admin فقط)
router.post("/", async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });
    const { name, description } = req.body;
    const created = await Department.create({ name, description });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

// PUT /api/departments/:id  (admin فقط)
router.put("/:id", async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });
    const { name, description } = req.body;
    const updated = await Department.findByIdAndUpdate(
      req.params.id,
      { $set: { name, description } },
      { new: true }
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/departments/:id  (admin فقط) — اختياري
router.delete("/:id", async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });
    await Department.findByIdAndDelete(req.params.id);
    // لا نحذف الفنيين — فقط نفصل القسم عنهم:
    await Technician.updateMany(
      { department: req.params.id },
      { $set: { department: null } }
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /api/departments/:id/repair-stats
router.get("/:id/repair-stats", async (req, res, next) => {
  try {
    const depId = new mongoose.Types.ObjectId(req.params.id);
    const stats = await Repair.aggregate([
      { $match: { currentDepartment: depId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const byStatus = {};
    let total = 0;
    for (const s of stats) {
      byStatus[s._id || "unknown"] = s.count;
      total += s.count;
    }
    res.json({ byStatus, total });
  } catch (e) {
    next(e);
  }
});

// GET /api/departments/:id/repairs?status=waiting&limit=20
router.get("/:id/repairs", async (req, res, next) => {
  try {
    const depId = req.params.id;
    const { status, limit = 20, page = 1 } = req.query;
    const q = { currentDepartment: depId };
    if (status) q.status = status;

    const list = await Repair.find(q)
      .select("code status customer device createdAt updatedAt technician")
      .populate("technician", "name username email")
      .sort({ updatedAt: -1 })
      .limit(Math.min(parseInt(limit, 10) || 20, 100))
      .skip(
        (Math.max(parseInt(page, 10) || 1, 1) - 1) * (parseInt(limit, 10) || 20)
      )
      .lean();

    res.json(list);
  } catch (e) {
    next(e);
  }
});

// PUT /api/departments/:id/monitor  (تعيين مراقب) — admin فقط
router.put("/:id/monitor", async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });
    const { userId } = req.body; // id للفني/المستخدم
    const dep = await Department.findByIdAndUpdate(
      req.params.id,
      { $set: { monitor: userId || null } },
      { new: true }
    ).populate("monitor", "username name email");
    // تأكد فني المراقب مُسند لنفس القسم:
    if (userId) {
      await Technician.findByIdAndUpdate(userId, {
        $set: { department: dep._id },
      });
    }
    res.json(dep);
  } catch (e) {
    next(e);
  }
});

// GET /api/departments/:id/technicians  (admin أو مراقب هذا القسم)
router.get("/:id/technicians", async (req, res, next) => {
  try {
    if (!isAdmin(req.user) && !(await isMonitorOf(req.user._id, req.params.id)))
      return res.status(403).json({ error: "Forbidden" });

    const techs = await Technician.find({ department: req.params.id })
      .select("name username email phone department")
      .lean();
    res.json(techs);
  } catch (e) {
    next(e);
  }
});

module.exports = router;

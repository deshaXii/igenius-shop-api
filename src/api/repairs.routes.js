const express = require("express");
const router = express.Router();
const Repair = require("../models/Repair.model");
const User = require("../models/User.model");
const Log = require("../models/Log.model");
const Counter = require("../models/Counter.model");
const Notification = require("../models/Notification.model");
const Settings = require("../models/Settings.model");
const auth = require("../middleware/auth");
const checkPermission = require("../middleware/checkPermission");
const { requireAny, isAdmin, hasPerm } = require("../middleware/perm");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { sendWebPushToUsers } = require("./push.routes");

// === Web Push (جديد) ===
const webpush = require("web-push");
const PushSub = require("../models/PushSub.model");
try {
  if (
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
  ) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } else {
    console.warn(
      "[web-push] VAPID env vars are missing; web push will be skipped."
    );
  }
} catch (e) {
  console.error("[web-push] init error:", e);
}

router.use(auth);

// ===== Helpers =====

function _label(field) {
  const map = {
    status: "الحالة",
    finalPrice: "السعر النهائي",
    price: "السعر",
    deliveryDate: "تاريخ التسليم",
    rejectedDeviceLocation: "مكان الجهاز",
    technician: "الفني",
  };
  return map[field] || field;
}
function summarizeChanges(changes = []) {
  return (changes || [])
    .filter((c) =>
      [
        "status",
        "finalPrice",
        "price",
        "deliveryDate",
        "rejectedDeviceLocation",
        "technician",
      ].includes(c.field)
    )
    .map((c) => ({
      field: c.field,
      label: _label(c.field),
      from: c.from ?? "—",
      to: c.to ?? "—",
    }))
    .slice(0, 5);
}

function canViewAll(user) {
  return (
    user?.role === "admin" ||
    user?.permissions?.adminOverride ||
    user?.permissions?.addRepair ||
    user?.permissions?.receiveDevice
  );
}
async function getAdmins() {
  return User.find({
    $or: [{ role: "admin" }, { "permissions.adminOverride": true }],
  })
    .select("_id")
    .lean();
}

// بث + حفظ إشعار
async function notifyUsers(req, userIds, message, type = "repair", meta = {}) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  // 1) احفظ الإشعار في DB
  const docs = await Notification.insertMany(
    userIds.map((u) => ({ user: u, message, type, meta }))
  );

  // 2) Socket.io بث فوري
  const io = req.app.get("io");
  if (io) {
    for (const n of docs) {
      io.to(String(n.user)).emit("notification:new", {
        _id: String(n._id),
        message: n.message,
        type: n.type,
        meta: n.meta || {},
        createdAt: n.createdAt,
      });
    }
  }

  // 3) Web Push إرسال
  const title =
    type === "repair" && meta?.repairNumber
      ? `تحديث صيانة #${meta.repairNumber}`
      : type === "repair"
        ? "تحديث صيانة"
        : "إشعار";

  const payload = {
    title,
    body: message || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: {
      url: meta?.repairId ? `/repairs/${meta.repairId}` : "/",
      ...meta,
    },
    vibrate: [100, 50, 100],
  };

  await sendWebPushToUsers(userIds, payload);
}

function diffChanges(oldDoc, newDoc, fields) {
  const changes = [];
  fields.forEach((f) => {
    const a = oldDoc[f],
      b = newDoc[f];
    if (JSON.stringify(a) !== JSON.stringify(b))
      changes.push({ field: f, from: a, to: b });
  });
  return changes;
}
async function nextRepairId() {
  const c = await Counter.findOneAndUpdate(
    { name: "repairId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return c.seq;
}
function baseUrl(req) {
  const host = req.get("x-forwarded-host") || req.get("host");
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}
function generateTrackingToken(len = 12) {
  return crypto
    .randomBytes(Math.ceil(len * 0.75))
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, len);
}
// عرض آمن مختصر للتحديث العام (للبث)
function publicPatchView(r) {
  return {
    repairId: r.repairId,
    status: r.status,
    createdAt: r.createdAt,
    startTime: r.startTime || null,
    endTime: r.endTime || null,
    deliveryDate: r.deliveryDate || null,
    eta: r.eta || null,
    notesPublic: r.notesPublic || null,
    finalPrice: typeof r.finalPrice === "number" ? r.finalPrice : null,
  };
}

// ===== LIST =====
router.get("/", auth, async (req, res) => {
  try {
    const { q, status, technician, startDate, endDate } = req.query;

    const filter = {};

    if (q) {
      const rx = new RegExp(
        String(q)
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      filter.$or = [
        { customerName: rx },
        { phone: rx },
        { deviceType: rx },
        { issue: rx },
        ...(filter.$or || []),
      ];
    }
    if (status) filter.status = status;
    if (technician) filter.technician = technician;

    if (startDate || endDate) {
      const start = startDate ? new Date(`${startDate}T00:00:00`) : null;
      const end = endDate ? new Date(`${endDate}T23:59:59.999`) : null;

      const createdCond = {};
      const deliveredCond = {};
      if (start) {
        createdCond.$gte = start;
        deliveredCond.$gte = start;
      }
      if (end) {
        createdCond.$lte = end;
        deliveredCond.$lte = end;
      }

      const dateOr = [];
      if (Object.keys(createdCond).length) dateOr.push({ createdAt: createdCond });
      if (Object.keys(deliveredCond).length)
        dateOr.push({ deliveryDate: deliveredCond });

      if (dateOr.length) {
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: dateOr }];
          delete filter.$or;
        } else {
          filter.$or = dateOr;
        }
      }
    }

    const canViewAllFlag =
      req.user.role === "admin" ||
      req.user.permissions?.adminOverride ||
      req.user.permissions?.addRepair ||
      req.user.permissions?.receiveDevice;

    if (!canViewAllFlag) {
      filter.technician = req.user.id;
    }

    const list = await Repair.find(filter)
      .sort({ createdAt: -1 })
      .populate("technician", "name")
      .populate("createdBy", "name")
      .populate("recipient", "name")
      .lean();

    res.json(list);
  } catch (e) {
    console.error("list repairs error:", e);
    res.status(500).json({ message: "تعذر تحميل البيانات" });
  }
});

// ===== GET one =====
router.get("/:id", async (req, res) => {
  const r = await Repair.findById(req.params.id)
    .populate("technician", "name")
    .populate("recipient", "name")
    .populate("createdBy", "name")
    .populate({
      path: "logs",
      options: { sort: { createdAt: -1 } },
      populate: { path: "changedBy", select: "name" },
    })
    .lean();
  if (!r) return res.status(404).json({ message: "Not found" });

  if (!canViewAll(req.user)) {
    if (
      !r.technician ||
      String(r.technician._id || r.technician) !== String(req.user.id)
    ) {
      return res
        .status(403)
        .json({ message: "ليست لديك صلاحية عرض هذه الصيانة" });
    }
  }

  res.json(r);
});

// ===== CREATE =====
router.post(
  "/",
  auth,
  requireAny(isAdmin, hasPerm("addRepair"), hasPerm("receiveDevice")),
  async (req, res) => {
    try {
      const payload = req.body || {};
      payload.repairId = await nextRepairId();
      payload.createdBy = req.user.id;

      // خلق توكن تتبّع
      const token = generateTrackingToken();
      payload.publicTracking = {
        enabled: true,
        token,
        showPrice: false,
        showEta: true,
      };

      const r = new Repair(payload);
      await r.save();

      const log = await Log.create({
        repair: r._id,
        action: "create",
        changedBy: req.user.id,
        details: "إنشاء صيانة جديدة",
      });
      await Repair.findByIdAndUpdate(r._id, { $push: { logs: log._id } });

      const admins = await getAdmins();
      const recipients = [];
      if (r.technician) recipients.push(r.technician.toString());
      recipients.push(...admins.map((a) => a._id.toString()));
      await notifyUsers(
        req,
        recipients,
        `تم إضافة صيانة جديدة #${r.repairId}`,
        "repair",
        {
          repairId: r._id,
          logId: log._id,
          deviceType: r.deviceType,
          repairNumber: r.repairId,
          changes: [],
        }
      );

      const trackingUrl = `${baseUrl(req)}/t/${token}`;
      const plain = r.toObject();
      plain.publicTrackingUrl = trackingUrl;

      res.json(r);
    } catch (e) {
      if (e?.code === 11000 && e?.keyPattern && e.keyPattern["parts.id"]) {
        return res.status(400).json({
          message:
            "فهرس قديم على parts.id يسبب تعارض. تم إزالة الاعتماد عليه في الكود. لو استمر الخطأ، أسقط الفهرس parts.id_1 من مجموعة repairs ثم أعد المحاولة.",
        });
      }
      console.error("create repair error:", e);
      res.status(500).json({ message: "تعذر إنشاء الصيانة" });
    }
  }
);

// ====== ضبط الضمان ======
function normalizeRejectedLocation(v) {
  if (v == null) return null;
  const s = String(v).trim();

  const t = s
    .replace(/\s+/g, " ")
    .replace(/[اأإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();

  const hasClient =
    t.includes("عميل") || t.includes("زبون") || t.includes("العميل");
  const hasShop =
    t.includes("محل") ||
    t.includes("المحل") ||
    t.includes("بالورشه") ||
    t.includes("بالدكان");

  if (hasClient) return "مع العميل";
  if (hasShop) return "بالمحل";

  if (s === "مع العميل" || s === "بالمحل") return s;

  return null;
}

router.post(
  "/:id/warranty",
  auth,
  checkPermission("editRepair"),
  async (req, res) => {
    const { id } = req.params;
    const { hasWarranty = true, warrantyEnd, warrantyNotes = "" } = req.body || {};
    const repair = await Repair.findById(id);
    if (!repair) return res.status(404).json({ message: "NOT_FOUND" });
    repair.hasWarranty = !!hasWarranty;
    if (warrantyEnd) repair.warrantyEnd = new Date(warrantyEnd);
    repair.warrantyNotes = String(warrantyNotes || "");
    await repair.save();
    return res.json({
      ok: true,
      hasWarranty: repair.hasWarranty,
      warrantyEnd: repair.warrantyEnd,
      warrantyNotes: repair.warrantyNotes,
    });
  }
);

// Create a customer-facing update (text/image/video/audio)
router.post(
  "/:id/customer-updates",
  auth,
  checkPermission("editRepair"),
  async (req, res) => {
    const { id } = req.params;
    const { type, text, fileUrl, isPublic = true } = req.body || {};
    if (!["text", "image", "video", "audio"].includes(type)) {
      return res.status(400).json({ message: "INVALID_TYPE" });
    }
    const repair = await Repair.findById(id);
    if (!repair) return res.status(404).json({ message: "NOT_FOUND" });

    const update = {
      type,
      text: type === "text" ? String(text || "") : "",
      fileUrl: type !== "text" ? String(fileUrl || "") : "",
      createdBy: req.user?._id || undefined,
      createdAt: new Date(),
      isPublic: !!isPublic,
    };
    repair.customerUpdates = repair.customerUpdates || [];
    repair.customerUpdates.push(update);
    await repair.save();
    return res.json({ ok: true, update });
  }
);

// (متروك للتوافق إن كنت تستخدمه في مكان آخر)
exports.setWarranty = async (req, res) => {
  const { warrantyEnd, warrantyNotes } = req.body;
  if (!warrantyEnd)
    return res.status(400).json({ message: "warrantyEnd required" });
  const repair = await Repair.findById(req.params.id);
  if (!repair) return res.status(404).json({ message: "Not found" });

  repair.hasWarranty = true;
  repair.warrantyEnd = new Date(warrantyEnd);
  if (typeof warrantyNotes === "string") repair.warrantyNotes = warrantyNotes;
  await repair.save();

  req.io?.to(`repair:${repair._id}`).emit("repairs:changed", { id: repair._id });
  return res.json({ ok: true });
};

// ===== UPDATE =====
router.put("/:id", async (req, res) => {
  const repair = await Repair.findById(req.params.id);
  if (!repair) return res.status(404).json({ message: "Not found" });

  const body = req.body || {};
  const user = req.user;

  // حقول الضمان (تُسمح مع من يملك صلاحية editRepair)
  const { hasWarranty, warrantyEnd, warrantyNotes } = body;
  if (typeof hasWarranty === "boolean") repair.hasWarranty = hasWarranty;
  if (warrantyEnd) repair.warrantyEnd = new Date(warrantyEnd);
  if (typeof warrantyNotes === "string") repair.warrantyNotes = warrantyNotes;

  const canEditAll =
    user.role === "admin" ||
    user.permissions?.adminOverride ||
    user.permissions?.editRepair;
  const isAssignedTech =
    repair.technician && String(repair.technician) === String(user.id);

  if (!canEditAll) {
    if (!isAssignedTech)
      return res.status(403).json({ message: "غير مسموح بالتعديل" });

    const allowedKeys = ["status", "password"];
    if (body.status === "تم التسليم") allowedKeys.push("finalPrice", "parts");
    if (body.status === "مرفوض") allowedKeys.push("rejectedDeviceLocation");

    const unknown = Object.keys(body).filter((k) => !allowedKeys.includes(k));
    if (unknown.length)
      return res.status(403).json({ message: "غير مسموح بالتعديل" });

    if (!body.password)
      return res.status(400).json({ message: "مطلوب كلمة السر للتأكيد" });
    const fresh = await User.findById(user.id);
    const ok = await fresh.comparePassword(body.password);
    if (!ok) return res.status(400).json({ message: "كلمة السر غير صحيحة" });
  }

  const before = repair.toObject();

  if (body.status) {
    if (body.status === "جاري العمل" && !repair.startTime)
      repair.startTime = new Date();
    if (body.status === "مكتمل" && !repair.endTime) repair.endTime = new Date();
    if (body.status === "تم التسليم") {
      repair.deliveryDate = new Date();
      repair.returned = false;
      repair.returnDate = undefined;
      if (typeof body.finalPrice !== "undefined")
        repair.finalPrice = Number(body.finalPrice) || 0;
      if (Array.isArray(body.parts)) repair.parts = body.parts;
    }
    if (body.status === "مرتجع") {
      repair.returned = true;
      repair.returnDate = new Date();
    }
    if (body.status === "مرفوض") {
      let loc = normalizeRejectedLocation(body.rejectedDeviceLocation);
      if (!loc) loc = "بالمحل";
      repair.rejectedDeviceLocation = loc;

      if (loc === "مع العميل") {
        if (!repair.deliveryDate) repair.deliveryDate = new Date();
      } else {
        repair.deliveryDate = undefined;
      }
    }
    repair.status = body.status;
  }

  if (canEditAll) {
    const assignIfDefined = (key, castFn) => {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        repair[key] = castFn ? castFn(body[key]) : body[key];
      }
    };
    assignIfDefined("customerName");
    assignIfDefined("phone");
    assignIfDefined("deviceType");
    assignIfDefined("color");
    assignIfDefined("issue");
    // price: متروك كما كان
    if (
      typeof body.finalPrice !== "undefined" &&
      body.status !== "تم التسليم"
    ) {
      repair.finalPrice = Number(body.finalPrice) || 0;
    }
    if (Array.isArray(body.parts) && body.status !== "تم التسليم")
      repair.parts = body.parts;
    assignIfDefined("notes");
    assignIfDefined("eta", (v) => (v ? new Date(v) : null));
    assignIfDefined("notesPublic");
    if (
      body.technician &&
      String(body.technician) !== String(repair.technician || "")
    ) {
      repair.technician = body.technician;
    }
    if (body.recipient) repair.recipient = body.recipient;
  }

  repair.updatedBy = user.id;
  await repair.save();

  const fieldsToTrack = [
    "status",
    "technician",
    "finalPrice",
    "notes",
    "recipient",
    "parts",
    "deliveryDate",
    "returnDate",
    "rejectedDeviceLocation",
    "customerName",
    "phone",
    "deviceType",
    "color",
    "issue",
    "price",
    "eta",
    "notesPublic",
    "hasWarranty",
    "warrantyEnd",
    "warrantyNotes",
  ];
  const after = repair.toObject();
  const changes = diffChanges(before, after, fieldsToTrack);
  const log = await Log.create({
    repair: repair._id,
    action: body.status && !canEditAll ? "status_change" : "update",
    changedBy: user.id,
    details: "تعديل على الصيانة",
    changes,
  });
  await Repair.findByIdAndUpdate(repair._id, { $push: { logs: log._id } });

  // بثّ عام (لو التتبّع شغّال)
  const io = req.app.get("io");
  const token = repair.publicTracking?.enabled && repair.publicTracking?.token;
  if (io && token) {
    io.to(`public:${token}`).emit(
      "public:repair:update",
      publicPatchView(repair)
    );
  }

  const admins = await getAdmins();
  const recipients = new Set(admins.map((a) => a._id.toString()));
  if (repair.technician) recipients.add(String(repair.technician));
  await notifyUsers(
    req,
    [...recipients],
    `تم تحديث صيانة #${repair.repairId}`,
    "repair",
    {
      repairId: repair._id,
      deviceType: repair.deviceType,
      repairNumber: repair.repairId,
      changes: summarizeChanges(changes),
    }
  );

  const populated = await Repair.findById(repair._id)
    .populate("technician", "name")
    .populate("recipient", "name")
    .populate("createdBy", "name")
    .lean();

  res.json(populated);
});

// ===== DELETE =====
router.delete(
  "/:id",
  require("../middleware/checkPermission")("deleteRepair"),
  async (req, res) => {
    const r = await Repair.findById(req.params.id);
    if (!r) return res.status(404).json({ message: "Not found" });
    await Repair.deleteOne({ _id: r._id });
    const log = await Log.create({
      repair: r._id,
      action: "delete",
      changedBy: req.user.id,
      details: "حذف الصيانة",
    });
    const admins = await getAdmins();
    await notifyUsers(
      req,
      admins.map((a) => a._id),
      `تم حذف صيانة #${r.repairId}`,
      "repair",
      { repairId: r._id }
    );
    res.json({ ok: true, logId: log._id });
  }
);

// ===== إدارة تتبّع عام
router.post("/:id/public-tracking", requireAny(isAdmin), async (req, res) => {
  const { id } = req.params;
  const { enabled, regenerate, showPrice, showEta } = req.body || {};
  const r = await Repair.findById(id);
  if (!r) return res.status(404).json({ message: "Not found" });

  if (!r.publicTracking) r.publicTracking = {};
  if (typeof enabled === "boolean") r.publicTracking.enabled = enabled;
  if (typeof showPrice !== "undefined") r.publicTracking.showPrice = !!showPrice;
  if (typeof showEta !== "undefined") r.publicTracking.showEta = !!showEta;

  if (regenerate || !r.publicTracking.token) {
    r.publicTracking.token = generateTrackingToken();
    r.publicTracking.createdAt = new Date();
    r.publicTracking.views = 0;
    r.publicTracking.lastViewedAt = null;
  }

  await r.save();
  const trackingUrl = `${baseUrl(req)}/t/${r.publicTracking.token}`;
  res.json({
    ok: true,
    token: r.publicTracking.token,
    url: trackingUrl,
    publicTracking: r.publicTracking,
  });
});

// ===== QR SVG جاهز للطباعة
router.get("/:id/public-qr.svg", requireAny(isAdmin), async (req, res) => {
  const r = await Repair.findById(req.params.id)
    .select("publicTracking repairId deviceType")
    .lean();
  if (!r || !r.publicTracking?.token) return res.status(404).end();
  const url = `${baseUrl(req)}/t/${r.publicTracking.token}`;
  res.setHeader("Content-Type", "image/svg+xml");
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    width: 256,
  });
  res.send(svg);
});

module.exports = router;

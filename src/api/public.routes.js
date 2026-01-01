// src/api/public.routes.js
const express = require("express");
const router = express.Router();
const Repair = require("../models/Repair.model");
const Settings = require("../models/Settings.model"); // لو مش مستخدم ممكن تشيله

// helpers
function safeTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function minDate(dates) {
  const ts = (dates || [])
    .map(safeTime)
    .filter(Boolean)
    .map((d) => d.getTime());
  if (!ts.length) return null;
  return new Date(Math.min(...ts));
}

function maxDate(dates) {
  const ts = (dates || [])
    .map(safeTime)
    .filter(Boolean)
    .map((d) => d.getTime());
  if (!ts.length) return null;
  return new Date(Math.max(...ts));
}

// ✅ قائمة حقول بنظام "inclusion" فقط (بدون -logs/-notes) لتفادي خطأ Mongo
const PUBLIC_REPAIR_FIELDS = [
  "_id",
  "repairId",
  "customerName",
  "deviceType",
  "color",
  "status",
  "createdAt",
  "startTime",
  "startedAt",
  "endTime",
  "completedAt",
  "deliveryDate",
  "eta",
  "finalPrice",
  "notesPublic",
  "publicTracking",
  "flows",
  "customerUpdates",
  "hasWarranty",
  "warrantyEnd",
  "warrantyNotes",
  "customerFeedback", // ✅ مهم
  "shopName",
  "shopPhone",
  "shopWhatsapp",
  "shopAddress",
  "shopWorkingHours",
].join(" ");

// شكل العرض الآمن للعميل
function toPublicView(doc) {
  const r = doc || {};
  const pt = r.publicTracking || {};

  const showPrice = pt.showPrice !== false;
  const showEta = pt.showEta !== false;

  const flows = Array.isArray(r.flows) ? r.flows : [];
  const deptTotal = flows.reduce((s, f) => s + (Number(f?.price) || 0), 0);

  const flowsStartedAt = flows.map((f) => f && f.startedAt).filter(Boolean);
  const flowsCompletedAt = flows.map((f) => f && f.completedAt).filter(Boolean);

  const createdAt = safeTime(r.createdAt);
  const startTime =
    safeTime(r.startTime) || safeTime(r.startedAt) || minDate(flowsStartedAt);
  const endTime =
    safeTime(r.endTime) || safeTime(r.completedAt) || maxDate(flowsCompletedAt);
  const deliveryDate = safeTime(r.deliveryDate);

  const timeline = [];
  if (createdAt)
    timeline.push({ key: "createdAt", label: "تم الاستلام", at: createdAt });
  if (startTime) timeline.push({ key: "start", label: "بدأ العمل", at: startTime });
  if (endTime) timeline.push({ key: "end", label: "اكتملت", at: endTime });
  if (deliveryDate)
    timeline.push({ key: "delivered", label: "تم التسليم", at: deliveryDate });

  const cf = r.customerFeedback || null;

  return {
    id: r._id,
    repairId: r.repairId,
    customerName: r.customerName,
    deviceType: r.deviceType,
    color: r.color,
    status: r.status,

    createdAt,
    startTime,
    endTime,
    deliveryDate,
    eta: showEta ? r.eta : undefined,

    departmentPriceTotal: showPrice ? deptTotal : undefined,
    finalPrice: showPrice ? (Number(r.finalPrice) || 0) : undefined,

    timeline,

    notesPublic: r.notesPublic,
    publicTracking: r.publicTracking,
    hasWarranty: r.hasWarranty,
    warrantyEnd: r.warrantyEnd,
    warrantyNotes: r.warrantyNotes,

    // ✅ رجّع التقييم
    customerFeedback: cf
      ? {
          rating: cf.rating ?? undefined,
          note: cf.note ?? undefined,
          createdAt: cf.createdAt ?? undefined,
        }
      : null,

    updates: (r.customerUpdates || [])
      .filter((u) => u.isPublic)
      .map((u) => ({
        type: u.type,
        text: u.text,
        fileUrl: u.fileUrl,
        createdAt: u.createdAt,
      })),
  };
}

// GET /api/public/repairs/:token
router.get("/repairs/:token", async (req, res, next) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ message: "TOKEN_REQUIRED" });

    const r = await Repair.findOneAndUpdate(
      {
        "publicTracking.enabled": true,
        "publicTracking.token": token,
      },
      {
        $inc: { "publicTracking.views": 1 },
        $set: { "publicTracking.lastViewedAt": new Date() },
      },
      { new: true }
    )
      .select(PUBLIC_REPAIR_FIELDS)
      .lean();

    if (!r) return res.status(404).json({ message: "NOT_FOUND" });

    return res.json({
      repair: toPublicView(r),
      shop: {
        name: r.shopName,
        phone: r.shopPhone,
        whatsapp: r.shopWhatsapp,
        address: r.shopAddress,
        workingHours: r.shopWorkingHours,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/public/repairs/:token/feedback
router.post("/repairs/:token/feedback", async (req, res, next) => {
  try {
    const token = String(req.params.token || "").trim();
    const { rating, note } = req.body || {};

    if (!token) return res.status(400).json({ message: "TOKEN_REQUIRED" });

    // ✅ مهم: نفس معيار GET (كان عندك publicToken وده غلط)
    // ✅ ومن غير select projection عشان ما يحصلش مشاكل validation مع save()
    const repair = await Repair.findOne({
      "publicTracking.enabled": true,
      "publicTracking.token": token,
    });

    if (!repair) {
      return res.status(404).json({ message: "طلب الصيانة غير موجود" });
    }

    // ✅ تنظيف صحيح للـ rating (ما نحولش 0 لـ 1)
    let cleanRating = 0;
    const numRating = Number(rating);
    if (Number.isFinite(numRating) && numRating >= 1 && numRating <= 5) {
      cleanRating = Math.round(numRating);
    }

    const cleanNote = (note || "").toString().trim().slice(0, 1000);

    if (!cleanRating && !cleanNote) {
      return res.status(400).json({ message: "لا يوجد بيانات للتقييم لإرسالها" });
    }

    repair.customerFeedback = {
      ...(cleanRating ? { rating: cleanRating } : {}),
      ...(cleanNote ? { note: cleanNote } : {}),
      createdAt: new Date(),
    };

    await repair.save();

    // ✅ رجّع نفس شكل GET
    const fresh = await Repair.findById(repair._id).select(PUBLIC_REPAIR_FIELDS).lean();

    return res.json({
      success: true,
      feedback: repair.customerFeedback,
      repair: fresh ? toPublicView(fresh) : undefined,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

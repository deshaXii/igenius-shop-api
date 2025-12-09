// src/api/public.routes.js
const express = require("express");
const router = express.Router();
const Repair = require("../models/Repair.model");
const Settings = require("../models/Settings.model");

// شكل العرض الآمن للعميل
function toPublicView(doc) {
  const r = doc;
  const pt = r.publicTracking || {};
  const showPrice = !!pt.showPrice;
  const showEta = pt.showEta !== false;

  const timeline = [];
  if (r.createdAt)
    timeline.push({ key: "createdAt", label: "تم الاستلام", at: r.createdAt });
  if (r.startTime)
    timeline.push({ key: "start", label: "بدأ العمل", at: r.startTime });
  if (r.endTime) timeline.push({ key: "end", label: "اكتملت", at: r.endTime });
  if (r.deliveryDate)
    timeline.push({
      key: "delivered",
      label: "تم التسليم",
      at: r.deliveryDate,
    });

  return {
    id: r._id,
    repairId: r.repairId,
    customerName: r.customerName,
    deviceType: r.deviceType,
    color: r.color,
    status: r.status,
    timeline,
    price: showPrice ? r.price : undefined,
    eta: showEta ? r.eta : undefined,
    notesPublic: r.notesPublic,
    publicTracking: r.publicTracking,
    hasWarranty: r.hasWarranty,
    warrantyEnd: r.warrantyEnd,
    warrantyNotes: r.warrantyNotes,
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
router.get("/repairs/:token", async (req, res) => {
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
    .select("-logs -notes")
    // .select(
    //   "repairId deviceType status createdAt startTime endTime deliveryDate eta notesPublic finalPrice publicTracking"
    // )
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
});

router.post("/repairs/:token/feedback", async (req, res, next) => {
  try {
    const { token } = req.params;
    const { rating, note } = req.body;

    // نفس الفيلد اللي بتستخدمه في GET /public/repairs/:token
    // عدّله لو عندك اسم مختلف (مثلاً trackingToken بدل publicToken)
    const repair = await Repair.findOne({ publicToken: token });
    if (!repair) {
      return res.status(404).json({ message: "طلب الصيانة غير موجود" });
    }

    const numRating = Number(rating);
    const cleanRating = Number.isFinite(numRating)
      ? Math.max(1, Math.min(5, numRating))
      : 0;
    const cleanNote = (note || "").toString().trim().slice(0, 1000);

    if (!cleanRating && !cleanNote) {
      return res
        .status(400)
        .json({ message: "لا يوجد بيانات للتقييم لإرسالها" });
    }

    repair.customerFeedback = {
      rating: cleanRating || undefined,
      note: cleanNote || undefined,
      createdAt: new Date(),
    };

    await repair.save();

    return res.json({
      success: true,
      feedback: repair.customerFeedback,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

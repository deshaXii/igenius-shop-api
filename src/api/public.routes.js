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
    timeline.push({
      key: "startTime",
      label: "بدأ الفني العمل",
      at: r.startTime,
    });
  if (r.endTime)
    timeline.push({ key: "endTime", label: "اكتملت الصيانة", at: r.endTime });
  if (r.deliveryDate)
    timeline.push({
      key: "deliveryDate",
      label: "تم التسليم",
      at: r.deliveryDate,
    });

  return {
    repairId: r.repairId,
    deviceType: r.deviceType,
    status: r.status,
    createdAt: r.createdAt,
    startTime: r.startTime || null,
    endTime: r.endTime || null,
    deliveryDate: r.deliveryDate || null,
    eta: showEta ? r.eta || null : null,
    notesPublic: r.notesPublic || null,
    finalPrice: showPrice
      ? typeof r.finalPrice === "number"
        ? r.finalPrice
        : null
      : null,
    timeline,
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
    .select(
      "repairId deviceType status createdAt startTime endTime deliveryDate eta notesPublic finalPrice publicTracking"
    )
    .lean();

  if (!r) return res.status(404).json({ message: "NOT_FOUND" });

  return res.json({
    repair: {
      _id: r._id,
      repairId: r.repairId,
      deviceType: r.deviceType,
      status: r.status,
      createdAt: r.createdAt,
      startTime: r.startTime,
      endTime: r.endTime,
      deliveryDate: r.deliveryDate,
      finalPrice: r.finalPrice,
      eta: r.eta,
      notesPublic: r.notesPublic,
      publicTracking: r.publicTracking, // فيه views & lastViewedAt
    },
    shop: {
      name: r.shopName,
      phone: r.shopPhone,
      whatsapp: r.shopWhatsapp,
      address: r.shopAddress,
      workingHours: r.shopWorkingHours,
    },
  });
});

module.exports = router;

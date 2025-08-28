"use strict";
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { requireAny, isAdmin } = require("../middleware/perm");
const Repair = require("../models/Repair.model");
const mongoose = require("mongoose"); // ضيفه أعلى الملف لو مش موجود
const Log = require("../models/Log.model"); // 👈 استخدم نفس موديل اللوج الأساسي

// GET /api/invoices/parts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&paid=unpaid|paid|all
router.get("/parts", auth, requireAny(isAdmin), async (req, res) => {
  try {
    const { startDate, endDate, paid = "unpaid" } = req.query;

    // فلترة بالتاريخ على تاريخ شراء القطعة
    const dateMatch = { "parts.purchaseDate": { $type: "date" } };
    if (startDate || endDate) {
      const start = startDate ? new Date(`${startDate}T00:00:00`) : null;
      const end = endDate ? new Date(`${endDate}T23:59:59.999`) : null;
      dateMatch["parts.purchaseDate"] = {};
      if (start) dateMatch["parts.purchaseDate"].$gte = start;
      if (end) dateMatch["parts.purchaseDate"].$lte = end;
    }

    // فلترة حالة الدفع
    const paidMatch =
      paid === "paid"
        ? { "parts.paid": true }
        : paid === "unpaid"
        ? {
            $or: [
              { "parts.paid": { $ne: true } },
              { "parts.paid": { $exists: false } },
            ],
          }
        : {}; // all

    const items = await Repair.aggregate([
      { $match: { parts: { $exists: true, $ne: [] } } },
      { $unwind: "$parts" },
      { $match: { ...dateMatch, ...paidMatch } },
      {
        $addFields: {
          _vendorNorm: {
            $let: {
              vars: {
                v: {
                  $ifNull: [
                    { $trim: { input: "$parts.supplier" } },
                    { $trim: { input: "$parts.vendor" } },
                    { $trim: { input: "$parts.vendorName" } },
                    { $trim: { input: "$parts.supplierName" } },
                  ],
                },
              },
              in: {
                $cond: [
                  { $or: [{ $eq: ["$$v", null] }, { $eq: ["$$v", ""] }] },
                  "غير محدد",
                  "$$v",
                ],
              },
            },
          },
          _sourceNorm: {
            $let: {
              vars: {
                s: {
                  $ifNull: [
                    { $trim: { input: "$parts.source" } },
                    { $trim: { input: "$parts.store" } },
                    { $trim: { input: "$parts.location" } },
                  ],
                },
              },
              in: {
                $cond: [
                  { $or: [{ $eq: ["$$s", null] }, { $eq: ["$$s", ""] }] },
                  "غير محدد",
                  "$$s",
                ],
              },
            },
          },
          _priceNum: {
            $convert: {
              input: { $ifNull: ["$parts.cost", "$parts.price"] },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _qtyNum: { $ifNull: ["$parts.qty", 1] },
        },
      },
      {
        $project: {
          repair: "$_id", // مهم علشان الـ POST mark-paid
          repairId: 1,
          status: 1,
          deviceType: 1,
          customerName: 1,
          technician: 1,
          deliveryDate: 1,
          part: {
            id: "$parts._id", // id الخاص بالقطعة
            name: "$parts.name",
            source: "$_sourceNorm",
            vendor: "$_vendorNorm",
            price: "$_priceNum",
            qty: "$_qtyNum",
            date: "$parts.purchaseDate",
            paid: { $toBool: { $ifNull: ["$parts.paid", false] } },
            paidAt: "$parts.paidAt",
            paidBy: "$parts.paidBy",
          },
        },
      },
      { $sort: { "part.date": 1, _id: 1 } },
    ]);

    const byVendor = await Repair.aggregate([
      { $match: { parts: { $exists: true, $ne: [] } } },
      { $unwind: "$parts" },
      { $match: { ...dateMatch, ...paidMatch } },
      {
        $addFields: {
          _vendorNorm: {
            $let: {
              vars: {
                v: {
                  $ifNull: [
                    { $trim: { input: "$parts.supplier" } },
                    { $trim: { input: "$parts.vendor" } },
                    { $trim: { input: "$parts.vendorName" } },
                    { $trim: { input: "$parts.supplierName" } },
                  ],
                },
              },
              in: {
                $cond: [
                  { $or: [{ $eq: ["$$v", null] }, { $eq: ["$$v", ""] }] },
                  "غير محدد",
                  "$$v",
                ],
              },
            },
          },
          _sourceNorm: {
            $let: {
              vars: {
                s: {
                  $ifNull: [
                    { $trim: { input: "$parts.source" } },
                    { $trim: { input: "$parts.store" } },
                    { $trim: { input: "$parts.location" } },
                  ],
                },
              },
              in: {
                $cond: [
                  { $or: [{ $eq: ["$$s", null] }, { $eq: ["$$s", ""] }] },
                  "غير محدد",
                  "$$s",
                ],
              },
            },
          },
          _priceNum: {
            $convert: {
              input: { $ifNull: ["$parts.cost", "$parts.price"] },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _qtyNum: { $ifNull: ["$parts.qty", 1] },
        },
      },
      {
        $group: {
          _id: { vendor: "$_vendorNorm", source: "$_sourceNorm" },
          total: { $sum: { $multiply: ["$_priceNum", "$_qtyNum"] } },
          count: { $sum: "$_qtyNum" },
        },
      },
      { $sort: { total: -1 } },
    ]);

    const totals = byVendor.reduce(
      (acc, v) => ({
        totalParts: acc.totalParts + (v.total || 0),
        count: acc.count + (v.count || 0),
      }),
      { totalParts: 0, count: 0 }
    );

    res.json({ items, byVendor, totals });
  } catch (e) {
    console.error("invoices/parts error:", e);
    res.status(500).json({ message: "تعذر تحميل قطع الغيار" });
  }
});

// ====== تعليم/إلغاء دفع قطعة ======
router.post(
  "/parts/:repairId/:partId/mark-paid",
  auth,
  requireAny(isAdmin),
  async (req, res) => {
    try {
      const { repairId, partId } = req.params;
      const { paid } = req.body || {};
      if (typeof paid !== "boolean") {
        return res
          .status(400)
          .json({ message: "قيمة paid مطلوبة (true/false)" });
      }

      const rid = mongoose.Types.ObjectId.isValid(repairId)
        ? new mongoose.Types.ObjectId(repairId)
        : null;
      if (!rid)
        return res.status(400).json({ message: "معرّف صيانة غير صالح" });

      const pidObj = mongoose.Types.ObjectId.isValid(partId)
        ? new mongoose.Types.ObjectId(partId)
        : null;
      const pidStr = String(partId);

      const now = paid ? new Date() : null;
      const setUpdate = {
        "parts.$.paid": paid,
        "parts.$.paidAt": now,
        "parts.$.paidBy": paid ? req.user.id : null,
      };

      // 1) جرّب بـ ObjectId
      let upd = pidObj
        ? await Repair.updateOne(
            { _id: rid, "parts._id": pidObj },
            { $set: setUpdate },
            { strict: false } // 👈 مهم
          )
        : { matchedCount: 0, nMatched: 0 };

      const matched1 = upd.matchedCount ?? upd.nMatched ?? 0;

      // 2) لو مفيش مطابقات، جرّب بـ String
      if (matched1 === 0) {
        upd = await Repair.updateOne(
          { _id: rid, "parts._id": pidStr },
          { $set: setUpdate },
          { strict: false } // 👈 مهم
        );
      }
      const matched = upd.matchedCount ?? upd.nMatched ?? 0;
      if (matched === 0) {
        return res.status(404).json({ message: "قطعة الغيار غير موجودة" });
      }

      // 3) اقرا القطعة بعد التحديث (أولًا بـ ObjectId ثم String)
      let doc = pidObj
        ? await Repair.findOne(
            { _id: rid, "parts._id": pidObj },
            { repairId: 1, "parts.$": 1 }
          ).lean()
        : null;
      if (!doc) {
        doc = await Repair.findOne(
          { _id: rid, "parts._id": pidStr },
          { repairId: 1, "parts.$": 1 }
        ).lean();
      }
      if (!doc || !doc.parts || !doc.parts[0]) {
        return res.status(404).json({ message: "قطعة الغيار غير موجودة" });
      }

      const p = doc.parts[0];

      // 4) سجلّ لوج يظهر في صفحة الصيانة
      try {
        const log = await Log.create({
          repair: rid,
          action: paid ? "part_paid" : "part_unpaid",
          changedBy: req.user.id,
          details: paid
            ? `تم دفع ثمن قطعة الغيار: ${p.name || "—"}${
                p.qty ? ` (الكمية ${p.qty})` : ""
              }${
                p.price || p.cost
                  ? ` — السعر: ${Number(p.price || p.cost)}`
                  : ""
              }`
            : `تم إلغاء علامة الدفع لقطعة الغيار: ${p.name || "—"}${
                p.qty ? ` (الكمية ${p.qty})` : ""
              }`,
          changes: [
            {
              field: "partPaid",
              from: !paid,
              to: paid,
              partId: String(p._id),
              partName: p.name || "—",
            },
            ...(paid
              ? [{ field: "paidAt", from: null, to: p.paidAt || new Date() }]
              : []),
          ],
        });

        // مهم: دفع الـ log داخل مصفوفة اللوجز الخاصة بالصيانة
        await Repair.findByIdAndUpdate(rid, { $push: { logs: log._id } });
      } catch (e) {
        console.warn("log write skipped:", e?.message || e);
      }
      return res.json({
        ok: true,
        part: {
          id: String(p._id),
          name: p.name || "—",
          paid: !!p.paid,
          paidAt: p.paidAt || null,
          paidBy: p.paidBy || null,
        },
      });
    } catch (e) {
      console.error("mark-paid error:", e);
      return res.status(500).json({ message: "تعذر تحديث حالة الدفع" });
    }
  }
);
module.exports = router;

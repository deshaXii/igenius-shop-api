const router = require("express").Router();
const requireAuth = require("../middleware/requireAuth");
const Supplier = require("../models/Supplier.model");
const Repair = require("../models/Repair.model");
const { fromZonedTime } = require("date-fns-tz");
const APP_TZ = process.env.APP_TZ || "Africa/Cairo";

router.use(requireAuth);

// seed shop if missing
async function ensureShop() {
  const exists = await Supplier.findOne({ isShop: true });
  if (!exists) {
    await Supplier.create({ name: "المحل", isShop: true, phone: "" });
  }
}

router.get("/", async (req, res) => {
  await ensureShop();
  const list = await Supplier.find().sort({ isShop: -1, name: 1 }).lean();
  res.json(list);
});

router.post("/", async (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || typeof name !== "string")
    return res.status(400).json({ message: "الاسم مطلوب" });
  const s = await Supplier.create({ name: name.trim(), phone: phone || "" });
  res.json(s);
});

// تجميع قطع المورد من الصيانات (parts.supplierId)
router.get("/:id/parts", async (req, res) => {
  const { id } = req.params;
  const { startDate, endDate } = req.query || {};
  const filterDate = {};
  const toUtcStart = (s) => fromZonedTime(`${s} 00:00:00`, APP_TZ);
  const toUtcEnd = (s) => fromZonedTime(`${s} 23:59:59.999`, APP_TZ);

  const repairs = await Repair.find({ "parts.supplierId": id })
    .select("repairId deviceType customerName createdAt parts technician")
    .populate("technician", "name")
    .lean();

  const rows = [];
  for (const r of repairs) {
    (r.parts || []).forEach((p, idx) => {
      if (String(p.supplierId || "") !== String(id)) return;
      // فلترة التاريخ (اختياري) على purchaseDate أو createdAt
      const d = p.purchaseDate
        ? new Date(p.purchaseDate)
        : new Date(r.createdAt);
      if (startDate && d < toUtcStart(startDate)) return;
      if (endDate && d > toUtcEnd(endDate)) return;

      rows.push({
        index: idx,
        repairId: r._id,
        repairNumber: r.repairId,
        deviceType: r.deviceType,
        partName: p.name || "",
        itemName: p.itemName || "",
        byName: r?.technician?.name || "",
        cost: typeof p.cost === "number" ? p.cost : null,
        purchaseDate: p.purchaseDate || r.createdAt,
        paid: !!p.paid,
      });
    });
  }
  // أحدث أولاً
  rows.sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));
  res.json(rows);
});

module.exports = router;

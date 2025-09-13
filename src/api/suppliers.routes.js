const router = require("express").Router();
const requireAuth = require("../middleware/requireAuth");
const Supplier = require("../models/Supplier.model");
const Repair = require("../models/Repair.model");
const { isValidObjectId } = require("mongoose");
const { fromZonedTime } = require("date-fns-tz");
const APP_TZ = process.env.APP_TZ || "Africa/Cairo";

router.use(requireAuth);

// upsert للمحل لتفادي E11000
async function ensureShop() {
  await Supplier.findOneAndUpdate(
    { isShop: true },
    { $setOnInsert: { name: "المحل", isShop: true, phone: "" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// قائمة الموردين
router.get("/", async (req, res) => {
  await ensureShop();
  const list = await Supplier.find().sort({ isShop: -1, name: 1 }).lean();
  res.json(list);
});

// إنشاء مورد
router.post("/", async (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ message: "الاسم مطلوب" });
  }
  try {
    const s = await Supplier.create({ name: name.trim(), phone: phone || "" });
    res.json(s);
  } catch (e) {
    // معالجة تكرار الاسم بشكل أنظف
    if (e?.code === 11000) {
      return res.status(409).json({ message: "اسم المورد مستخدم بالفعل" });
    }
    throw e;
  }
});

// ✅ إحضار مورد واحد
router.get("/:id", async (req, res) => {
  await ensureShop();
  const { id } = req.params;

  let s = null;
  if (id === "shop") {
    s = await Supplier.findOne({ isShop: true }).lean();
  } else if (isValidObjectId(id)) {
    s = await Supplier.findById(id).lean();
  }

  if (!s) return res.status(404).json({ message: "المورد غير موجود" });
  res.json(s);
});

// ✅ تجميع قطع المورد من الصيانات
router.get("/:id/parts", async (req, res) => {
  await ensureShop();
  const { id } = req.params;
  const { startDate, endDate } = req.query || {};

  // تأكد أن المورد موجود أولًا
  let supplierDoc = null;
  if (id === "shop") {
    supplierDoc = await Supplier.findOne({ isShop: true }).lean();
  } else if (isValidObjectId(id)) {
    supplierDoc = await Supplier.findById(id).lean();
  }
  if (!supplierDoc)
    return res.status(404).json({ message: "المورد غير موجود" });

  const supplierId = String(supplierDoc._id);

  const toUtcStart = (s) => fromZonedTime(`${s} 00:00:00`, APP_TZ);
  const toUtcEnd = (s) => fromZonedTime(`${s} 23:59:59.999`, APP_TZ);

  const repairs = await Repair.find({ "parts.supplierId": supplierId })
    .select("repairId deviceType customerName createdAt parts technician")
    .populate("technician", "name")
    .lean();

  const rows = [];
  for (const r of repairs) {
    (r.parts || []).forEach((p, idx) => {
      if (String(p.supplierId || "") !== supplierId) return;

      // فلترة التاريخ على purchaseDate أو createdAt
      const d = p.purchaseDate
        ? new Date(p.purchaseDate)
        : new Date(r.createdAt);
      if (startDate && d < toUtcStart(startDate)) return;
      if (endDate && d > toUtcEnd(endDate)) return;

      rows.push({
        index: idx,
        repairId: r._id, // لفتح شاشة الصيانة
        repairNumber: r.repairId, // الرقم المقروء للعميل
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

  rows.sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));
  res.json(rows);
});

module.exports = router;

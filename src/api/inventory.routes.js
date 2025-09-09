// routes/inventory.items.js
const router = require("express").Router();
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const InventoryItem = require("../models/InventoryItem.model");

// لو عندك موديل موردين
let Supplier;
try {
  Supplier = require("../models/Supplier.model");
} catch (_) {
  Supplier = null;
}

router.use(requireAuth);

/* ================= Helpers ================= */
function toNumOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normCategory(input) {
  if (!input) return "part";
  const v = String(input).trim();
  if (["part", "قطع غيار"].includes(v)) return "part";
  if (["accessory", "اكسسوار", "إكسسوار"].includes(v)) return "accessory";
  return "part";
}
function serializeItem(doc) {
  const it = doc || {};
  const supplier =
    it.supplier && typeof it.supplier === "object"
      ? {
          _id: String(it.supplier._id || it.supplier.id || ""),
          name: it.supplier.name,
          isShop: !!it.supplier.isShop,
        }
      : undefined;

  return {
    _id: String(it._id),
    name: it.name,
    category: it.category || "part",
    sku: it.sku || "",
    unitCost:
      typeof it.unitCost === "number"
        ? it.unitCost
        : toNumOrNull(it.unitCost) ?? undefined,
    stock:
      typeof it.stock === "number"
        ? it.stock
        : typeof it.qty === "number"
        ? it.qty
        : toNumOrNull(it.stock) ?? toNumOrNull(it.qty) ?? 0,
    minStock:
      typeof it.minStock === "number"
        ? it.minStock
        : toNumOrNull(it.minStock) ?? undefined,
    supplier, // { _id, name, isShop } إن وُجد
    notes: it.notes ?? it.note ?? "",
  };
}

/* ================= GET / =================
   يدعم ?q= و ?category=part|accessory  */
router.get("/", async (req, res) => {
  try {
    const { q, category } = req.query;
    const filter = {};

    if (q) {
      const rx = new RegExp(String(q).trim().replace(/\s+/g, ".*"), "i");
      filter.$or = [{ name: rx }, { sku: rx }, { notes: rx }, { note: rx }];
    }
    if (category) {
      filter.category = normCategory(category);
    }

    let qry = InventoryItem.find(filter).sort({ name: 1 });
    if (Supplier) qry = qry.populate("supplier", "name isShop");
    const list = await qry.lean();

    res.json(list.map(serializeItem));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "تعذر تحميل الأصناف" });
  }
});

/* ================= POST / =================
   إنشاء صنف جديد — يقرأ الحقول المتوقعة من الواجهة */
router.post("/", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.name || !String(p.name).trim()) {
      return res.status(400).json({ message: "الاسم مطلوب" });
    }

    const payload = {
      name: String(p.name).trim(),
      category: normCategory(p.category),
      sku: p.sku ? String(p.sku).trim() : "",
      unitCost: toNumOrNull(p.unitCost) ?? 0,
      // تخزين باسمين لدعم المخطط القديم والجديد
      stock: toNumOrNull(p.stock) ?? toNumOrNull(p.qty) ?? 0,
      qty: toNumOrNull(p.stock) ?? toNumOrNull(p.qty) ?? 0,
      minStock: toNumOrNull(p.minStock) ?? undefined,
      notes: p.notes ? String(p.notes) : p.note ? String(p.note) : "",
      note: p.note ? String(p.note) : p.notes ? String(p.notes) : "",
    };

    if (p.supplierId && Supplier && mongoose.isValidObjectId(p.supplierId)) {
      payload.supplier = p.supplierId;
    }

    const created = await InventoryItem.create(payload);
    // populate (اختياري) عشان الرد يكون كامل زي الواجهة
    const fresh = Supplier
      ? await InventoryItem.findById(created._id)
          .populate("supplier", "name isShop")
          .lean()
      : await InventoryItem.findById(created._id).lean();

    res.json(serializeItem(fresh));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "تعذر إنشاء الصنف" });
  }
});

/* ================= PUT /:id =================
   تعديل صنف — يحدث فقط الحقول المرسلة */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const p = req.body || {};
    const set = {};
    const unset = {};

    if (p.name != null) set.name = String(p.name).trim();
    if (p.category != null) set.category = normCategory(p.category);
    if (p.sku != null) set.sku = String(p.sku).trim();

    if (p.unitCost != null) {
      const n = toNumOrNull(p.unitCost);
      if (n != null) set.unitCost = n;
    }

    if (p.stock != null || p.qty != null) {
      const n = toNumOrNull(p.stock) ?? toNumOrNull(p.qty);
      if (n != null) {
        set.stock = n; // للحقل الجديد
        set.qty = n; // توافق مع القديم
      }
    }

    if (p.minStock != null) {
      const n = toNumOrNull(p.minStock);
      if (n != null) set.minStock = n;
      else unset.minStock = 1;
    }

    if (p.notes != null || p.note != null) {
      const v = p.notes ?? p.note ?? "";
      set.notes = String(v);
      set.note = String(v);
    }

    if ("supplierId" in p) {
      if (p.supplierId && Supplier && mongoose.isValidObjectId(p.supplierId)) {
        set.supplier = p.supplierId;
      } else {
        // إلغاء الربط
        set.supplier = undefined;
        unset.supplier = 1;
      }
    }

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;

    const q = InventoryItem.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });

    const saved = Supplier
      ? await q.populate("supplier", "name isShop").lean()
      : await q.lean();

    if (!saved) return res.status(404).json({ message: "العنصر غير موجود" });
    res.json(serializeItem(saved));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "تعذر تعديل الصنف" });
  }
});

/* ================= DELETE /:id ================= */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const del = await InventoryItem.findByIdAndDelete(id).lean();
    if (!del) return res.status(404).json({ message: "العنصر غير موجود" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "تعذر حذف الصنف" });
  }
});

module.exports = router;

// src/routes/repairs.routes.js
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const Repair = require("../models/Repair.model");
const User = require("../models/User.model");
const Counter = require("../models/Counter.model");
const Notification = require("../models/Notification.model");
const Department = require("../models/Department.model");

const auth = require("../middleware/auth");
const checkPermission = require("../middleware/checkPermission");
const { requireAny, isAdmin: isAdminPerm, hasPerm } = require("../middleware/perm");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { sendWebPushToUsers } = require("./push.routes");
const { fromZonedTime } = require("date-fns-tz");
const APP_TZ = process.env.APP_TZ || "Africa/Cairo";
const requireAuth = require("../middleware/requireAuth");

// ===== Web Push =====
const webpush = require("web-push");
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
    console.warn("[web-push] VAPID env vars are missing; web push will be skipped.");
  }
} catch (e) {
  console.error("[web-push] init error:", e);
}

router.use(requireAuth);

/* ===== AuthZ helpers (normalize perms + context) ===== */
const PERM_KEYS = [
  "accessAccounts",
  "addRepair",
  "editRepair",
  "deleteRepair",
  "receiveDevice",
  "settings",
  "adminOverride",
];
const toBool = (v) =>
  v === true || v === 1 || v === "1" || v === "true" || v === "on" || v === "yes";

function normalizePerms(doc) {
  const src = (doc && (doc.permissions || doc.perms || doc)) || {};
  const out = {};
  for (const k of PERM_KEYS) out[k] = toBool(src[k] ?? false);

  // توحيد الاستلام/الإضافة
  if (out.addRepair || out.receiveDevice) {
    out.addRepair = true;
    out.receiveDevice = true;
  }
  // أدمن شامل
  if (out.adminOverride) {
    for (const k of PERM_KEYS) out[k] = true;
  }
  return out;
}

async function getAuthContext(req) {
  const base = req.user || {};
  const dbUser = await User.findById(base._id || base.id)
    .select("role permissions perms isSeedAdmin department")
    .lean();
  const perms = normalizePerms(dbUser || base || {});
  const isAdmin =
    !!dbUser &&
    (dbUser.role === "admin" || perms.adminOverride === true || base.isAdmin === true);
  const hasIntake = perms.addRepair || perms.receiveDevice;
  const canEditAll = isAdmin || perms.editRepair === true;
  const canDelete = isAdmin || perms.deleteRepair === true;

  return { dbUser, perms, isAdmin, hasIntake, canEditAll, canDelete };
}

/* ===== Logs helpers (embedded) ===== */
function pushLog(doc, type, by, payload = {}) {
  try {
    doc.logs = Array.isArray(doc.logs) ? doc.logs : [];
    doc.logs.push({
      type,
      by: by ? String(by) : undefined,
      at: new Date(),
      payload,
      _v: "embedded",
    });
  } catch (e) {
    console.log("[logs] push error:", e?.message);
  }
}
function normalizeLogsForRead(logs = [], limit = 200) {
  const arr = Array.isArray(logs) ? logs : [];
  const onlyEmbedded = arr.filter((x) => x && typeof x === "object" && x.type);
  onlyEmbedded.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  return onlyEmbedded.slice(0, limit);
}

/* ===== Helpers ===== */
async function isMonitorOf(userId, deptId) {
  if (!userId || !deptId) return false;
  const d = await Department.findById(deptId).select("monitor").lean();
  return !!(d && d.monitor && String(d.monitor) === String(userId));
}
function currentFlow(repair) {
  if (!repair.flows || repair.flows.length === 0) return null;
  const i = [...repair.flows].reverse().findIndex((f) => f.status !== "completed");
  const idx = i === -1 ? repair.flows.length - 1 : repair.flows.length - 1 - i;
  return { flow: repair.flows[idx], idx };
}
function deny(msg = "Forbidden", code = 403) {
  const err = new Error(msg);
  err.status = code;
  return err;
}

/** إذن إدارة الخطوة الحالية حسب نوع الإجراء */
async function assertCanManageStep(req, repair, flow, action, payload = {}) {
  const cur = currentFlow(repair);
  if (!cur || String(cur.flow._id) !== String(flow._id))
    throw deny("هذه ليست الخطوة الحالية", 403);

  const ctx = await getAuthContext(req);
  const editor = ctx.canEditAll; // أدمن/أدمن صلاحيات أو معه editRepair
  const monitor = await isMonitorOf(ctx.dbUser?._id, flow.department);
  const assigned =
    !!flow?.technician && String(flow.technician) === String(ctx.dbUser?._id);
  const sameDept =
    String(ctx.dbUser?.department || "") === String(flow.department || "");

  if (action === "assign_technician") {
    const selfAssign =
      payload?.technicianId && String(payload.technicianId) === String(ctx.dbUser?._id);
    if (editor || monitor || (selfAssign && sameDept)) return true;
    throw deny(
      "غير مسموح بتعيين فنّي. يُسمح للمراقب/الأدمن أو للفنّي نفسه من نفس القسم.",
      403
    );
  }

  if (action === "complete_step") {
    if (editor || monitor || assigned) return true;
    throw deny(
      "غير مسموح بتعليم الخطوة كمكتملة إلا للأدمن/المراقب أو الفنّي المعيَّن.",
      403
    );
  }

  if (action === "move_next") {
    if (editor || monitor || assigned) return true;
    throw deny("غير مسموح بنقل الصيانة للخطوة التالية.", 403);
  }

  if (editor || monitor) return true;
  throw deny();
}

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
      ["status", "finalPrice", "price", "deliveryDate", "rejectedDeviceLocation", "technician"].includes(
        c.field
      )
    )
    .map((c) => ({
      field: c.field,
      label: _label(c.field),
      from: c.from ?? "—",
      to: c.to ?? "—",
    }))
    .slice(0, 5);
}
async function getAdmins() {
  return User.find({
    $or: [{ role: "admin" }, { "permissions.adminOverride": true }],
  })
    .select("_id")
    .lean();
}
async function notifyUsers(req, userIds, message, type = "repair", meta = {}) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;
  const docs = await Notification.insertMany(
    userIds.map((u) => ({ user: u, message, type, meta }))
  );
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
    data: { url: meta?.repairId ? `/repairs/${meta.repairId}` : "/", ...meta },
    vibrate: [100, 50, 100],
  };
  try {
    setImmediate(() => {
      sendWebPushToUsers(userIds, payload).catch((err) =>
        console.log("[web-push] send error:", err?.message)
      );
    });
  } catch (e) {
    console.log("[web-push] skipped:", e?.message);
  }
}
function diffChanges(oldDoc, newDoc, fields) {
  const changes = [];
  fields.forEach((f) => {
    const a = oldDoc[f],
      b = newDoc[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field: f, from: a, to: b });
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
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}
function generateTrackingToken(len = 12) {
  return crypto
    .randomBytes(Math.ceil(len * 0.75))
    .toString("base64")
    .replace(/[/=]/g, "")
    .slice(0, len);
}
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

/* ===== LIST ===== */
router.get("/", auth, async (req, res) => {
  try {
    const ctx = await getAuthContext(req);

    const { q, status, technician, startDate, endDate, department } = req.query;
    const filter = {};

    if (q) {
      const rx = new RegExp(
        String(q).trim().replace(/[.*?^${}()|[\]\\]/g, "\\$&"),
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
    if (department) filter.currentDepartment = department;

    if (startDate || endDate) {
      const toUtcStart = (s) => fromZonedTime(`${s} 00:00:00`, APP_TZ);
      const toUtcEnd = (s) => fromZonedTime(`${s} 23:59:59.999`, APP_TZ);
      const start = startDate ? toUtcStart(startDate) : null;
      const end = endDate ? toUtcEnd(endDate) : null;
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
      if (Object.keys(deliveredCond).length) dateOr.push({ deliveryDate: deliveredCond });
      if (dateOr.length) {
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: dateOr }];
          delete filter.$or;
        } else {
          filter.$or = dateOr;
        }
      }
    }

    // تقييدات الرؤية:
    if (!(ctx.isAdmin || ctx.hasIntake)) {
      const uid = String(ctx.dbUser?._id || "");
      if (!department) {
        const mine = await Department.findOne({ monitor: uid }).select("_id").lean();
        if (mine) {
          filter.currentDepartment = mine._id;
        } else {
          filter.technician = uid;
        }
      }
    }

    const list = await Repair.find(filter)
      .sort({ createdAt: -1 })
      .populate("technician", "name username email")
      .populate("createdBy", "name")
      .populate("recipient", "name")
      .lean();

    res.json(list);
  } catch (e) {
    console.error("list repairs error:", e);
    res.status(500).json({ message: "تعذر تحميل البيانات" });
  }
});

/* ===== GET one ===== */
router.get("/:id", async (req, res) => {
  try {
    const ctx = await getAuthContext(req);

    const r = await Repair.findById(req.params.id)
      .populate("technician", "name username email")
      .populate("recipient", "name")
      .populate("createdBy", "name")
      .lean();
    if (!r) return res.status(404).json({ message: "Not found" });

    let allowed = false;

    // أدمن/انتك (استلام/إضافة) = يشوف الكل
    if (ctx.isAdmin || ctx.hasIntake) {
      allowed = true;
    }

    // الفني المعيّن
    if (!allowed && r.technician && String(r.technician._id || r.technician) === String(ctx.dbUser?._id)) {
      allowed = true;
    }

    // مراقب القسم الحالي
    if (!allowed && r.currentDepartment) {
      const ok = await isMonitorOf(ctx.dbUser?._id, r.currentDepartment);
      if (ok) allowed = true;
    }

    if (!allowed) {
      return res.status(403).json({ message: "ليست لديك صلاحية عرض هذه الصيانة" });
    }

    r.logs = normalizeLogsForRead(r.logs, 200);
    res.json(r);
  } catch (e) {
    console.error("get repair error:", e);
    res.status(500).json({ message: "تعذر تحميل البيانات" });
  }
});

/* ===== CREATE ===== */
router.post(
  "/",
  auth,
  // ميدلويرك الحالي يسمح بالأدمن (role) أو addRepair/receiveDevice
  requireAny(isAdminPerm, hasPerm("addRepair"), hasPerm("receiveDevice")),
  async (req, res) => {
    try {
      const payload = req.body || {};
      const initialDepartment = payload.initialDepartment || payload.department || null;
      const initialTechnician = payload.technician || null;

      payload.repairId = await nextRepairId();
      payload.createdBy = req.user.id;

      // tracking token
      const token = generateTrackingToken();
      payload.publicTracking = {
        enabled: true,
        token,
        showPrice: false,
        showEta: true,
      };

      const r = new Repair({
        ...payload,
        currentDepartment: initialDepartment || null,
        department: initialDepartment || null,
        flows: initialDepartment
          ? [
              {
                department: initialDepartment,
                technician: initialTechnician || null,
                status: initialTechnician ? "in_progress" : "waiting",
                startedAt: initialTechnician ? new Date() : null,
              },
            ]
          : [],
        logs: [],
      });

      // log: create
      pushLog(r, "create", req.user?._id || req.user?.id, {
        initialDepartment,
        initialTechnician,
      });

      await r.save();

      const admins = await getAdmins();
      const recipients = [];
      if (r.technician) recipients.push(r.technician.toString());
      recipients.push(...admins.map((a) => a._id.toString()));
      notifyUsers(req, recipients, `تم إضافة صيانة جديدة #${r.repairId}`, "repair", {
        repairId: r._id,
        deviceType: r.deviceType,
        repairNumber: r.repairId,
        changes: [],
      });

      res.json(r);
    } catch (e) {
      if (e?.code === 11000 && e?.keyPattern && e.keyPattern["parts.id"]) {
        return res.status(400).json({
          message:
            "فهرس قديم على parts.id يسبب تعارض. لو استمر الخطأ، أسقط الفهرس parts.id_1 من مجموعة repairs ثم أعد المحاولة.",
        });
      }
      console.error("create repair error:", e);
      res.status(500).json({ message: "تعذر إنشاء الصيانة" });
    }
  }
);

/* ===== TIMELINE + ACL ===== */
router.get("/:id/timeline", async (req, res) => {
  try {
    const ctx = await getAuthContext(req);

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "InvalidId" });

    const r = await Repair.findById(id)
      .populate("flows.department", "name")
      .populate("flows.technician", "name username email")
      .populate("currentDepartment", "name")
      .lean();

    if (!r) return res.status(404).json({ error: "NotFound" });

    // تحقق عرض تايملاين: نفس قواعد GET one
    let allowed = ctx.isAdmin || ctx.hasIntake;
    if (!allowed && r.currentDepartment) {
      const ok = await isMonitorOf(ctx.dbUser?._id, r.currentDepartment);
      if (ok) allowed = true;
    }
    if (!allowed && r.flows?.some((f) => String(f.technician?._id || f.technician) === String(ctx.dbUser?._id))) {
      allowed = true;
    }
    if (!allowed) return res.status(403).json({ error: "Forbidden" });

    const flows = Array.isArray(r.flows) ? r.flows : [];
    const total = flows.reduce((s, f) => s + (Number(f.price) || 0), 0);

    const cur = flows.length ? flows[flows.length - 1] : null;
    const monitor = cur ? await isMonitorOf(ctx.dbUser?._id, cur.department) : false;
    const assigned = cur
      ? String(cur.technician?._id || cur.technician || "") === String(ctx.dbUser?._id)
      : false;
    const editor = ctx.canEditAll;
    const sameDept = cur
      ? String(ctx.dbUser?.department || "") === String(cur.department || "")
      : false;

    const acl = {
      canAssignTech: !!(editor || monitor || (sameDept && cur && cur.status !== "completed")),
      canCompleteCurrent: !!(editor || monitor || assigned),
      canMoveNext: !!(editor || monitor || (assigned && cur && cur.status === "completed")),
    };

    return res.json({
      currentDepartment: r.currentDepartment || null,
      flows,
      logs: normalizeLogsForRead(r.logs, 200),
      departmentPriceTotal: total,
      acl,
    });
  } catch (e) {
    console.error("timeline error:", e);
    return res.status(500).json({ error: "TimelineFailed" });
  }
});

/* ===== Assign technician ===== */
router.put("/:id/assign-tech", async (req, res, next) => {
  try {
    const { flowId, technicianId } = req.body;
    const r = await Repair.findById(req.params.id);
    if (!r) return res.status(404).json({ error: "NotFound" });

    const { flow } = flowId ? { flow: r.flows.id(flowId) } : currentFlow(r);
    if (!flow) return res.status(400).json({ error: "NoActiveFlow" });

    await assertCanManageStep(req, r, flow, "assign_technician", {
      technicianId,
    });

    flow.technician = technicianId || null;
    if (flow.status === "waiting" && technicianId) {
      flow.status = "in_progress";
      flow.startedAt = new Date();
    }

    pushLog(r, "assign_technician", req.user?._id || req.user?.id, {
      flowId: flow._id,
      technicianId,
    });

    await r.save();

    const out = await Repair.findById(r._id)
      .select("flows currentDepartment")
      .populate("flows.department", "name")
      .populate("flows.technician", "name username email")
      .lean();
    res.json(out);
  } catch (e) {
    next(e);
  }
});

/* ===== Complete step ===== */
router.put("/:id/complete-step", async (req, res, next) => {
  try {
    const { flowId, price, notes } = req.body;
    const r = await Repair.findById(req.params.id);
    if (!r) return res.status(404).json({ error: "NotFound" });

    const { flow } = flowId ? { flow: r.flows.id(flowId) } : currentFlow(r);
    if (!flow) return res.status(400).json({ error: "NoActiveFlow" });

    await assertCanManageStep(req, r, flow, "complete_step");

    flow.status = "completed";
    flow.completedAt = new Date();
    if (price != null) flow.price = Number(price) || 0;
    if (notes != null) flow.notes = notes;

    pushLog(r, "flow_complete", req.user?._id || req.user?.id, {
      flowId: flow._id,
      price: flow.price,
      notes: flow.notes || "",
    });

    await r.save();

    const out = await Repair.findById(r._id)
      .select("flows currentDepartment")
      .populate("flows.department", "name")
      .populate("flows.technician", "name username email")
      .lean();
    res.json(out);
  } catch (e) {
    next(e);
  }
});

/* ===== Move next ===== */
router.put("/:id/move-next", async (req, res, next) => {
  try {
    const { departmentId } = req.body;
    if (!departmentId) return res.status(400).json({ error: "MissingDepartment" });

    const r = await Repair.findById(req.params.id);
    if (!r) return res.status(404).json({ error: "NotFound" });

    const cur = currentFlow(r);
    if (!cur || cur.flow.status !== "completed") {
      if (cur && cur.flow.status !== "completed")
        return res.status(409).json({ error: "CurrentNotCompleted" });
    } else {
      await assertCanManageStep(req, r, cur.flow, "move_next");
    }

    r.flows.push({
      department: departmentId,
      status: "waiting",
      technician: null,
      startedAt: null,
      completedAt: null,
    });
    r.currentDepartment = departmentId;
    r.department = departmentId;

    pushLog(r, "move_next", req.user?._id || req.user?.id, { departmentId });

    await r.save();

    const out = await Repair.findById(r._id)
      .select("flows currentDepartment")
      .populate("flows.department", "name")
      .populate("flows.technician", "name username email")
      .lean();

    res.json(out);
  } catch (e) {
    next(e);
  }
});

/* ===== Warranty ===== */
function normalizeRejectedLocation(v) {
  if (v == null) return null;
  const s = String(v).trim();

  const t = s
    .replace(/\s/g, " ")
    .replace(/[اأإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();

  const hasClient = t.includes("عميل") || t.includes("زبون") || t.includes("العميل");
  const hasShop = t.includes("محل") || t.includes("المحل") || t.includes("بالورشه") || t.includes("بالدكان");

  if (hasClient) return "مع العميل";
  if (hasShop) return "بالمحل";
  if (s === "مع العميل" || s === "بالمحل") return s;
  return null;
}

router.post("/:id/warranty", auth, checkPermission("editRepair"), async (req, res) => {
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
});

/* ===== Customer updates (public) ===== */
router.post("/:id/customer-updates", auth, checkPermission("editRepair"), async (req, res) => {
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
});

/* ===== UPDATE (also handles status transitions) ===== */
router.put("/:id", async (req, res, next) => {
  try {
    const ctx = await getAuthContext(req);
    const repair = await Repair.findById(req.params.id);
    if (!repair) return res.status(404).json({ message: "Not found" });

    const body = req.body || {};
    const userId = ctx.dbUser?._id;

    // Warranty fields
    const { hasWarranty, warrantyEnd, warrantyNotes } = body;
    if (typeof hasWarranty === "boolean") repair.hasWarranty = hasWarranty;
    if (warrantyEnd) repair.warrantyEnd = new Date(warrantyEnd);
    if (typeof warrantyNotes === "string") repair.warrantyNotes = warrantyNotes;

    const canEditAll = ctx.canEditAll;
    const isAssignedTech = repair.technician && String(repair.technician) === String(userId);

    if (!canEditAll) {
      if (!isAssignedTech) return res.status(403).json({ message: "غير مسموح بالتعديل" });

      const allowedKeys = ["status", "password"];
      if (body.status === "تم التسليم") allowedKeys.push("finalPrice", "parts");
      if (body.status === "مرفوض") allowedKeys.push("rejectedDeviceLocation");

      const unknown = Object.keys(body).filter((k) => !allowedKeys.includes(k));
      if (unknown.length) return res.status(403).json({ message: "غير مسموح بالتعديل" });

      if (!body.password) return res.status(400).json({ message: "مطلوب كلمة السر للتأكيد" });
      const fresh = await User.findById(userId);
      const ok = await fresh.comparePassword(body.password);
      if (!ok) return res.status(400).json({ message: "كلمة السر غير صحيحة" });
    }

    const before = repair.toObject();

    if (body.status) {
      if (body.status === "جاري العمل" && !repair.startTime) repair.startTime = new Date();
      if (body.status === "مكتمل" && !repair.endTime) repair.endTime = new Date();
      if (body.status === "تم التسليم") {
        repair.deliveryDate = new Date();
        repair.returned = false;
        repair.returnDate = undefined;
        if (typeof body.finalPrice !== "undefined") repair.finalPrice = Number(body.finalPrice) || 0;
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

      pushLog(repair, "status_change", userId, { status: body.status });
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
      if (typeof body.finalPrice !== "undefined" && body.status !== "تم التسليم") {
        repair.finalPrice = Number(body.finalPrice) || 0;
      }
      if (Array.isArray(body.parts) && body.status !== "تم التسليم") repair.parts = body.parts;
      assignIfDefined("notes");
      assignIfDefined("eta", (v) => (v ? new Date(v) : null));
      assignIfDefined("notesPublic");
      if (body.technician && String(body.technician) !== String(repair.technician || "")) {
        repair.technician = body.technician;
      }
      if (body.recipient) repair.recipient = body.recipient;
    }

    repair.updatedBy = userId;
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

    pushLog(repair, body.status && !canEditAll ? "status_change" : "update", userId, {
      changes,
    });
    await repair.save();

    const io = req.app.get("io");
    const token = repair.publicTracking?.enabled && repair.publicTracking?.token;
    if (io && token) {
      io.to(`public:${token}`).emit("public:repair:update", publicPatchView(repair));
    }

    const admins = await getAdmins();
    const recipients = new Set(admins.map((a) => a._id.toString()));
    if (repair.technician) recipients.add(String(repair.technician));
    notifyUsers(req, [...recipients], `تم تحديث صيانة #${repair.repairId}`, "repair", {
      repairId: repair._id,
      deviceType: repair.deviceType,
      repairNumber: repair.repairId,
      changes: summarizeChanges(changes),
    });

    const populated = await Repair.findById(repair._id)
      .populate("technician", "name username email")
      .populate("recipient", "name")
      .populate("createdBy", "name")
      .lean();

    populated.logs = normalizeLogsForRead(populated.logs, 200);
    res.json(populated);
  } catch (e) {
    console.error("update repair error:", e);
    next(e);
  }
});

/* ===== DELETE ===== */
router.delete("/:id", checkPermission("deleteRepair"), async (req, res, next) => {
  try {
    const r = await Repair.findById(req.params.id);
    if (!r) return res.status(404).json({ message: "Not found" });

    pushLog(r, "delete", req.user?._id || req.user?.id, {});
    await r.save();

    await Repair.deleteOne({ _id: r._id });

    const admins = await getAdmins();
    notifyUsers(
      req,
      admins.map((a) => a._id),
      `تم حذف صيانة #${r.repairId}`,
      "repair",
      { repairId: r._id }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("delete repair error:", e);
    next(e);
  }
});

/* ===== Public tracking on/off ===== */
router.post("/:id/public-tracking", requireAny(isAdminPerm), async (req, res) => {
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

/* ===== QR SVG ===== */
router.get("/:id/public-qr.svg", requireAny(isAdminPerm), async (req, res) => {
  const r = await Repair.findById(req.params.id)
    .select("publicTracking repairId deviceType")
    .lean();
  if (!r || !r.publicTracking?.token) return res.status(404).end();
  const url = `${baseUrl(req)}/t/${r.publicTracking.token}`;
  res.setHeader("Content-Type", "image/svgxml");
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 256 });
  res.send(svg);
});

module.exports = router;

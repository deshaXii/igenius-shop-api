"use strict";

const path = require("path");
require("dotenv").config({
  // لو .env في جذر مشروع الباك اند
  path: path.resolve(__dirname, "../../.env"),
});

const mongoose = require("mongoose");

const Repair = require("../models/Repair.model");
const Department = require("../models/Department.model");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME;

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

async function main() {
  if (!MONGO_URI) {
    console.error("Missing MONGO_URI / MONGODB_URI");
    process.exit(1);
  }

  // ✅ اتصل بالـ DB name الصحيح حتى لو الـ URI مش فيه اسم الداتا بيز
  await mongoose.connect(MONGO_URI, {
    dbName: MONGO_DB_NAME || undefined,
    serverSelectionTimeoutMS: 15000,
  });

  const targetDeptId = arg("--target"); // اختياري: --target <deptId>

  const deps = await Department.find({}).select("_id name").lean();
  const existingDeptIds = deps.map((d) => d._id);
  const deptSet = new Set(deps.map((d) => String(d._id)));

  let targetDept = null;

  if (targetDeptId) {
    if (!mongoose.Types.ObjectId.isValid(targetDeptId)) {
      throw new Error("Invalid --target department id");
    }
    targetDept = await Department.findById(targetDeptId)
      .select("_id name")
      .lean();
    if (!targetDept) throw new Error("Target department not found");
  } else {
    const name = "غير مصنف";
    targetDept =
      (await Department.findOne({ name }).select("_id name").lean()) ||
      (await Department.create({
        name,
        description: "قسم افتراضي لإصلاح الأقسام المحذوفة",
      }).then((d) => ({ _id: d._id, name: d.name })));

    // ضيفه لقائمة الأقسام الموجودة
    existingDeptIds.push(targetDept._id);
    deptSet.add(String(targetDept._id));
  }

  // ✅ التقط الصيانات اللي بتشير لأقسام محذوفة أو flows.department اتعملها populate وطلعت null
  const orphans = await Repair.find({
    $or: [
      { currentDepartment: { $ne: null, $nin: existingDeptIds } },
      { department: { $ne: null, $nin: existingDeptIds } },
      { "flows.department": { $nin: existingDeptIds } },
      { "flows.department": null },
    ],
  });

  let fixed = 0;

  for (const r of orphans) {
    let changed = false;

    const curDep = r.currentDepartment ? String(r.currentDepartment) : null;
    const dep = r.department ? String(r.department) : null;

    if (curDep && !deptSet.has(curDep)) {
      r.currentDepartment = targetDept._id;
      changed = true;
    }
    if (dep && !deptSet.has(dep)) {
      r.department = targetDept._id;
      changed = true;
    }

    // ✅ أصلّح فقط الـ flow الحالية (غير المكتملة) لو قسمها محذوف أو null
    const flows = Array.isArray(r.flows) ? r.flows : [];
    const active = [...flows].reverse().find((f) => f && f.status !== "completed");
    if (active) {
      const aDep = active.department ? String(active.department) : null;
      if (!aDep || !deptSet.has(aDep)) {
        active.department = targetDept._id;
        changed = true;
      }
    }

    if (changed) {
      await r.save();
      fixed++;
    }
  }

  console.log(`Target dept: ${targetDept.name} (${targetDept._id})`);
  console.log(`Orphan repairs scanned: ${orphans.length}`);
  console.log(`Repairs fixed: ${fixed}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

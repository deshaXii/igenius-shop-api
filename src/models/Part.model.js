// src/models/Part.model.js
const mongoose = require("mongoose");

const partSchema = new mongoose.Schema(
  {
    // ⚠️ إزالة unique/index لتفادي تعارضات null
    id: { type: Number }, // اختياري؛ يفضل الاعتماد على _id
    name: String,
    source: String,
    cost: Number,
    usedIn: { type: mongoose.Schema.Types.ObjectId, ref: "Repair" },
    technician: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true, _id: true }
);

module.exports = mongoose.model("Part", partSchema);

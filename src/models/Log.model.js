// src/models/Log.model.js
const mongoose = require("mongoose");

const ChangeSchema = new mongoose.Schema(
  {
    field: String,
    from: mongoose.Schema.Types.Mixed,
    to: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const LogSchema = new mongoose.Schema(
  {
    repair: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Repair",
      required: true,
    },
    action: {
      type: String,
      enum: ["create", "update", "delete", "status_change", "assign"],
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    details: { type: String },
    changes: { type: [ChangeSchema], default: [] },
    oldTechnician: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    newTechnician: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Log || mongoose.model("Log", LogSchema);

// src/models/Message.model.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    // channel: "public" أو "dm"
    channel: { type: String, enum: ["public", "dm"], required: true },
    from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // للـ public نترك recipients فارغة؛ للـ dm نضع [userA, userB]
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    content: { type: String, required: true, trim: true },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Message || mongoose.model("Message", MessageSchema);

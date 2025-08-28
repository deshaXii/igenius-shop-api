const mongoose = require("mongoose");

const PushSubSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    endpoint: { type: String, unique: true },
    keys: {
      p256dh: String,
      auth: String,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.PushSub || mongoose.model("PushSub", PushSubSchema);

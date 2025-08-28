const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const PushSub = require("../models/PushSub.model");
const webpush = require("web-push");

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

router.use(auth);

// حفظ/تحديث الاشتراك
router.post("/subscribe", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint)
      return res.status(400).json({ message: "Invalid subscription" });

    await PushSub.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { user: req.user.id, ...subscription },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("subscribe error:", e);
    res.status(500).json({ message: "subscribe failed" });
  }
});

// دالة مساعدة للإرسال
async function sendWebPushToUsers(userIds, payload) {
  const subs = await PushSub.find({ user: { $in: userIds } }).lean();
  const tasks = subs.map((s) =>
    webpush.sendNotification(s, JSON.stringify(payload)).catch(async (err) => {
      // اشتراكات ميتة → احذفها
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        try {
          await PushSub.deleteOne({ endpoint: s.endpoint });
        } catch {}
      } else {
        console.error(
          "webpush error:",
          err?.statusCode,
          err?.body || err?.message
        );
      }
    })
  );
  await Promise.allSettled(tasks);
}

// إرسال Push تجريبي لنفس المستخدم
router.post("/test", async (req, res) => {
  const payload = {
    title: "تجربة إشعار",
    body: "لو وصلك ده يبقى الويب بوش تمام ✅",
    icon: "/icons/icon-192.png",
    data: { url: "/" },
  };
  await sendWebPushToUsers([req.user.id], payload);
  res.json({ ok: true });
});

module.exports = { router, sendWebPushToUsers };

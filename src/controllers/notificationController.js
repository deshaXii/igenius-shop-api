// controllers/notificationController.js
const Notification = require("../models/Notification.model.js");

// ✅ جلب كل الإشعارات
const getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50); // آخر 50 إشعار
    res.json(notifications);
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ message: "فشل في جلب الإشعارات" });
  }
};

// ✅ تعليم إشعار كمقروء
const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notification = await Notification.findById(id);

    if (!notification) {
      return res.status(404).json({ message: "الإشعار غير موجود" });
    }

    notification.read = true;
    await notification.save();

    res.json({ message: "تم تعليم الإشعار كمقروء" });
  } catch (err) {
    console.error("Error marking notification as read:", err);
    res.status(500).json({ message: "فشل في تحديث الإشعار" });
  }
};

// ✅ مسح كل الإشعارات
const clearNotifications = async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user.id });
    res.json({ message: "تم مسح كل الإشعارات" });
  } catch (err) {
    console.error("Error clearing notifications:", err);
    res.status(500).json({ message: "فشل في مسح الإشعارات" });
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  clearNotifications,
};

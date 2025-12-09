// Enumerated stages for a unified workflow
module.exports = {
  RECEIVED: "RECEIVED", // تم الاستلام (فحص مبدئي)
  DIAGNOSIS: "DIAGNOSIS", // التشخيص
  IN_PROGRESS: "IN_PROGRESS", // جارية لدى القسم الحالي
  QA_CHECK: "QA_CHECK", // فحص جودة نهائي
  READY_FOR_PICKUP: "READY_FOR_PICKUP", // جاهز للتسليم
  DELIVERED: "DELIVERED", // تم التسليم للعميل
  ON_HOLD: "ON_HOLD", // موقوف (بانتظار قطع/موافقة)
  CANCELLED: "CANCELLED", // أُلغيت
};

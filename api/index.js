// api/index.js  (Vercel serverless entry)
let app;
try {
  app = require("../src/app"); // لو app.js داخل src/
} catch {
  app = require("../src/app"); // لو app.js في الجذر
}

// مهم: Express app نفسه دالة (req,res) — نمرره مباشرة
module.exports = (req, res) => app(req, res);

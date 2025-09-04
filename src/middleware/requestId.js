const { randomUUID } = require("crypto");
function requestId(req, res, next) {
  const rid = req.headers["x-request-id"] || randomUUID();
  req.id = rid;
  res.setHeader("x-request-id", rid);
  next();
}

module.exports = { requestId };

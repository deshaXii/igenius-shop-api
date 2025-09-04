// Simple Zod-based validator middleware
const { ZodError } = require("zod");

const validate =
  (schema, which = "body") =>
  (req, res, next) => {
    try {
      if (!schema) return next();
      const data = schema.parse(req[which]);
      req.valid = req.valid || {};
      req.valid[which] = data;
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res
          .status(400)
          .json({ error: "ValidationError", issues: err.issues });
      }
      return next(err);
    }
  };

module.exports = { validate };

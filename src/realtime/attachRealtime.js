// src/realtime/attachRealtime.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

/**
 * Attach Socket.IO to HTTP server.
 * - Soft-auth: if JWT is invalid/missing we still allow connection (as guest).
 * - Exposes io via app.set("io", io)
 * - Tracks sockets by userId for targeted/broadcast-except-self emits.
 */
module.exports = function attachRealtime(server, app) {
  const io = new Server(server, {
    cors: { origin: "*", credentials: true },
    path: "/socket.io",
  });

  // Map userId -> Set<socket.id>
  const userSockets = new Map();
  io.userSockets = userSockets; // expose for debugging

  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.query?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1] ||
        "";

      if (token) {
        try {
          const payload = jwt.verify(
            token,
            process.env.JWT_SECRET || process.env.JWT_KEY || "secret"
          );
          socket.user = {
            id: payload.id || payload._id || payload.sub || null,
          };
        } catch (e) {
          console.warn("[socket] JWT invalid:", e.message);
          socket.user = { id: null };
        }
      } else {
        socket.user = { id: null };
      }
      return next();
    } catch (err) {
      console.warn("[socket] auth middleware error:", err.message);
      // لا تمنع الاتصال — خليه guest
      socket.user = { id: null };
      return next();
    }
  });

  io.on("connection", (socket) => {
    const uid = socket.user?.id || null;
    if (uid) {
      if (!userSockets.has(uid)) userSockets.set(uid, new Set());
      userSockets.get(uid).add(socket.id);
    }

    socket.emit("connected", { ok: true, id: socket.id });

    socket.on("disconnect", () => {
      if (uid && userSockets.has(uid)) {
        userSockets.get(uid).delete(socket.id);
        if (userSockets.get(uid).size === 0) userSockets.delete(uid);
      }
    });
  });

  app.set("io", io);
  return io;
};

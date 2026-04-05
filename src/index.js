import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { nanoid } from "nanoid";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);

const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "http://localhost:3001,http://localhost:3000,https://sds-live-location.vercel.app")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const PORT = Number(process.env.PORT || 1402);
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

app.use(
  cors({
    origin: FRONTEND_ORIGINS,
    credentials: true
  })
);
app.use(express.json());

const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      destination: null,
      users: new Map(),
      updatedAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

app.get("/", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post("/rooms", (_req, res) => {
  const roomId = nanoid(10);
  const room = getOrCreateRoom(roomId);
  res.status(201).json({
    roomId: room.id,
    destination: room.destination
  });
});

app.get("/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ message: "Room not found" });
  }
  return res.json({
    roomId: room.id,
    destination: room.destination,
    users: [...room.users.values()]
  });
});

app.post("/rooms/:roomId/destination", (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ message: "lat and lng must be numbers" });
  }
  const room = getOrCreateRoom(req.params.roomId);
  room.destination = { lat, lng };
  room.updatedAt = Date.now();
  io.to(room.id).emit("destination:update", room.destination);
  return res.json({
    roomId: room.id,
    destination: room.destination
  });
});

app.get("/places/autocomplete", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ predictions: [] });
  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({ message: "GOOGLE_MAPS_API_KEY is not configured" });
  }

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text"
      },
      body: JSON.stringify({
        input: query,
        languageCode: "en"
      })
    });

    if (!response.ok) {
      const body = await response.text();
      return res.status(502).json({ message: "Autocomplete request failed", details: body });
    }

    const data = await response.json();
    const predictions =
      data?.suggestions
        ?.map((item) => item?.placePrediction)
        ?.filter(Boolean)
        ?.map((p) => ({
          placeId: p.placeId,
          text: p.text?.text || ""
        }))
        ?.filter((p) => p.placeId && p.text) || [];

    return res.json({ predictions });
  } catch (error) {
    return res.status(500).json({ message: "Autocomplete request failed", error: String(error) });
  }
});

app.get("/places/details", async (req, res) => {
  const placeId = String(req.query.placeId || "").trim();
  if (!placeId) return res.status(400).json({ message: "placeId is required" });
  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({ message: "GOOGLE_MAPS_API_KEY is not configured" });
  }

  try {
    const response = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "id,displayName,formattedAddress,location"
        }
      }
    );

    if (!response.ok) {
      const body = await response.text();
      return res.status(502).json({ message: "Place details request failed", details: body });
    }

    const data = await response.json();
    const lat = data?.location?.latitude;
    const lng = data?.location?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(502).json({ message: "Place details missing coordinates" });
    }

    return res.json({
      placeId: data.id || placeId,
      name: data?.displayName?.text || "",
      address: data?.formattedAddress || "",
      lat,
      lng
    });
  } catch (error) {
    return res.status(500).json({ message: "Place details request failed", error: String(error) });
  }
});

app.get("/routes/drive", async (req, res) => {
  const fromLat = Number(req.query.fromLat);
  const fromLng = Number(req.query.fromLng);
  const toLat = Number(req.query.toLat);
  const toLng = Number(req.query.toLng);

  if (![fromLat, fromLng, toLat, toLng].every((v) => Number.isFinite(v))) {
    return res.status(400).json({ message: "fromLat, fromLng, toLat, toLng must be numbers" });
  }

  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      return res.status(502).json({ message: "Route request failed", details: body });
    }

    const data = await response.json();
    const route = data?.routes?.[0];
    const coordinates = Array.isArray(route?.geometry?.coordinates)
      ? route.geometry.coordinates
      : [];
    const durationSec = typeof route?.duration === "number" ? route.duration : null;
    const distanceMeters = typeof route?.distance === "number" ? route.distance : null;

    return res.json({ coordinates, durationSec, distanceMeters });
  } catch (error) {
    return res.status(500).json({ message: "Route request failed", error: String(error) });
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: FRONTEND_ORIGINS,
    credentials: true
  }
});

io.on("connection", (socket) => {
  socket.on("room:join", ({ roomId, userId, name }) => {
    if (!roomId || !userId) return;
    const room = getOrCreateRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = userId;
    room.users.set(userId, {
      userId,
      name: name || "User",
      lat: null,
      lng: null,
      accuracy: null,
      speed: null,
      heading: null,
      lastSeen: Date.now()
    });
    io.to(roomId).emit("room:state", {
      roomId: room.id,
      destination: room.destination,
      users: [...room.users.values()]
    });
  });

  socket.on("location:update", ({ roomId, userId, lat, lng, accuracy, speed, heading }) => {
    if (!roomId || !userId) return;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    const room = getOrCreateRoom(roomId);
    const existing = room.users.get(userId) || { userId, name: "User" };
    const updated = {
      ...existing,
      lat,
      lng,
      accuracy: typeof accuracy === "number" ? accuracy : null,
      speed: typeof speed === "number" ? speed : null,
      heading: typeof heading === "number" ? heading : null,
      lastSeen: Date.now()
    };
    room.users.set(userId, updated);
    io.to(roomId).emit("users:update", [...room.users.values()]);
  });

  socket.on("disconnect", () => {
    const { roomId, userId } = socket.data;
    if (!roomId || !userId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.users.delete(userId);
    io.to(roomId).emit("users:update", [...room.users.values()]);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Live location backend running on http://localhost:${PORT}`);
});

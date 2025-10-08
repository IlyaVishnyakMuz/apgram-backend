// users.js (исправленный — register/login генерируют/возвращают auth_token; остальные методы требуют токен/owner)
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
router.use(cors());
router.use(express.json());

let db;
(async () => {
  db = await open({
    filename: path.join(__dirname, "users.db"),
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      telegram_token TEXT,
      channel_id TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      add_images INTEGER DEFAULT 1,
      use_own_posts INTEGER DEFAULT 0,
      use_other_channels INTEGER DEFAULT 0,
      channels_list TEXT,
      use_sites INTEGER DEFAULT 0,
      sites_list TEXT,
      auth_token TEXT UNIQUE
    )
  `);
})();

/**
 * Helper: get requester id by auth token (x-auth-token) OR fallback to numeric userId (x-auth-token)
 * Returns number or null
 */
async function getRequesterId(req) {
  // token first
  const token =
    req.headers["x-auth-token"] ||
    req.headers["x_auth_token"] ||
    (req.body && req.body.auth_token) ||
    (req.query && req.query.auth_token);

  if (token) {
    try {
      const row = await db.get("SELECT id FROM users WHERE auth_token = ?", token);
      if (row && row.id) return row.id;
    } catch (e) {
      // ignore, fallback to legacy
    }
  }

  // legacy: numeric userId in body/query/header
  if (req.body && req.body.userId !== undefined && req.body.userId !== null) {
    const n = Number(req.body.userId);
    return Number.isInteger(n) ? n : null;
  }
  if (req.query && req.query.userId !== undefined && req.query.userId !== null) {
    const n = Number(req.query.userId);
    return Number.isInteger(n) ? n : null;
  }
  const header = req.headers["x-auth-token"] || req.headers["x_user_id"];
  if (header !== undefined && header !== null) {
    const n = Number(header);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

// Public: регистрация (без проверок userId) — генерируем auth_token и возвращаем его
router.post("/register", async (req, res) => {
  try {
    const { username, password, telegram_token, channel_id } = req.body;

    if (!username || !password || !telegram_token || !channel_id)
      return res.status(400).json({ success: false, error: "Все поля обязательны" });

    const existing = await db.get("SELECT id FROM users WHERE username = ?", username);
    if (existing) return res.status(400).json({ success: false, error: "Такой пользователь уже существует" });

    const hashed = await bcrypt.hash(password, 10);
    const auth_token = crypto.randomBytes(32).toString("hex");

    const result = await db.run(
      "INSERT INTO users (username, password, telegram_token, channel_id, auth_token) VALUES (?, ?, ?, ?, ?)",
      [username, hashed, telegram_token, channel_id, auth_token]
    );

    res.json({ success: true, message: "✅ Пользователь зарегистрирован", userId: result.lastID, auth_token });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Public: вход (без проверок userId) — возвращаем auth_token
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.get("SELECT * FROM users WHERE username = ?", username);
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(403).json({ success: false, error: "Неверный пароль" });

    res.json({
      success: true,
      message: "✅ Вход выполнен",
      userId: user.id,
      telegram_token: user.telegram_token,
      channel_id: user.channel_id,
      auth_token: user.auth_token
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET settings — доступен только владельцу (userId/token)
// теперь возвращаем username, telegram_token, channel_id и все настройки
router.get("/settings/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const requesterId = await getRequesterId(req);
    if (requesterId === null) {
      return res.status(400).json({ success: false, error: "user authentication required (provide x-auth-token or auth_token or x-auth-token)" });
    }
    if (Number(userId) !== requesterId) {
      return res.status(403).json({ success: false, error: "Доступ запрещён" });
    }

    const settings = await db.get(
      `SELECT 
         username,
         telegram_token,
         channel_id,
         add_images,
         use_own_posts,
         use_other_channels,
         channels_list,
         use_sites,
         sites_list
       FROM users 
       WHERE id = ?`,
      userId
    );

    if (!settings) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    res.json({
      success: true,
      settings: {
        username: settings.username,
        telegram_token: settings.telegram_token,
        channel_id: settings.channel_id,
        add_images: !!settings.add_images,
        use_own_posts: !!settings.use_own_posts,
        use_other_channels: !!settings.use_other_channels,
        channels_list: settings.channels_list ? JSON.parse(settings.channels_list) : [],
        use_sites: !!settings.use_sites,
        sites_list: settings.sites_list ? JSON.parse(settings.sites_list) : [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT settings — доступен только владельцу (userId/token)
// теперь можно также менять channel_id и telegram_token
router.put("/settings/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const requesterId = await getRequesterId(req);
    if (requesterId === null) {
      return res.status(400).json({ success: false, error: "user authentication required (provide x-auth-token or auth_token or x-auth-token)" });
    }
    if (Number(userId) !== requesterId) {
      return res.status(403).json({ success: false, error: "Доступ запрещён" });
    }

    const {
      add_images,
      use_own_posts,
      use_other_channels,
      channels_list,
      use_sites,
      sites_list,
      channel_id,
      telegram_token,
    } = req.body;

    await db.run(
      `UPDATE users
       SET 
         add_images = ?, 
         use_own_posts = ?, 
         use_other_channels = ?, 
         channels_list = ?, 
         use_sites = ?, 
         sites_list = ?,
         channel_id = COALESCE(?, channel_id),
         telegram_token = COALESCE(?, telegram_token)
       WHERE id = ?`,
      [
        add_images ? 1 : 0,
        use_own_posts ? 1 : 0,
        use_other_channels ? 1 : 0,
        JSON.stringify(channels_list || []),
        use_sites ? 1 : 0,
        JSON.stringify(sites_list || []),
        channel_id || null,
        telegram_token || null,
        userId,
      ]
    );

    res.json({ success: true, message: "✅ Настройки обновлены" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

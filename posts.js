// posts.js (исправленный — проверка владельца для всех операций, кроме тех, что явно публичны)
import TelegramBot from "node-telegram-bot-api";
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import { WebSocketServer } from "ws";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { generatePosts as generatePostsService } from "./generation.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
router.use(cors());
router.use(express.json());

let db;
let usersDb;

(async () => {
  db = await open({
    filename: path.join(__dirname, "posts.db"),
    driver: sqlite3.Database,
  });

  usersDb = await open({
    filename: path.join(__dirname, "users.db"),
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      url TEXT,
      scheduledAt TEXT,
      sent INTEGER DEFAULT 0
    )
  `);
})();

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype))
      return cb(new Error("Only JPEG, PNG or WEBP images allowed"));
    cb(null, true);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

let wss;
const clients = new Set();

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}

/**
 * Helper: get requester id by auth token (x-auth-token) OR fallback to numeric userId (x-auth-token/body/query)
 * Returns number or null
 *
 * - First tries auth token (x-auth-token header, body.auth_token, query.auth_token) and looks up usersDb
 * - If token not provided or not found, falls back to numeric userId from body/query/header (legacy)
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
      const row = await usersDb.get("SELECT id FROM users WHERE auth_token = ?", token);
      if (row && row.id) return row.id;
    } catch (e) {
      // ignore and fallthrough to legacy checks
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

/**
 * Helper: verify ownership of a post.
 * If requesterId missing -> 400
 * If not owner -> 403
 * Returns true if ok (owner), false if response already sent
 */
async function verifyOwnershipOrReject(post, req, res) {
  const requesterId = await getRequesterId(req);
  if (requesterId === null) {
    res.status(400).json({ success: false, error: "user authentication required (provide x-auth-token or auth_token or x-auth-token)" });
    return false;
  }
  if (post.user_id !== requesterId) {
    res.status(403).json({ success: false, error: "Доступ запрещён" });
    return false;
  }
  return true;
}

// ✅ теперь маршрут просто "/", а не "/posts"
// создание поста — требует, чтобы requesterId совпадал с userId в теле
router.post("/", async (req, res) => {
  try {
    const { userId, title, description, url } = req.body;

    const requesterId = await getRequesterId(req);
    if (requesterId === null) {
      return res.status(400).json({ success: false, error: "user authentication required (provide x-auth-token or auth_token or x-auth-token)" });
    }
    if (Number(userId) !== requesterId) {
      return res.status(403).json({ success: false, error: "Доступ запрещён" });
    }

    const result = await db.run(
      "INSERT INTO posts (user_id, title, description, url, scheduledAt) VALUES (?, ?, ?, ?, NULL)",
      [userId, title, description, url]
    );
    broadcast({ type: "posts_updated" });
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ загрузка изображений — требует user auth (token or legacy userId)
router.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const requesterId = await getRequesterId(req);
    if (requesterId === null) {
      // multer may have parsed multipart fields into req.body
      return res.status(400).json({ success: false, error: "user authentication required (provide x-auth-token or auth_token or x-auth-token)" });
    }

    if (!req.file)
      return res.status(400).json({ success: false, error: "Файл не загружен" });
    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    res.json({ success: true, url: imageUrl.replace(/\\/g, "/") });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ получение постов пользователя — требует совпадение requesterId === :userId
router.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const requesterId = await getRequesterId(req);

    if (requesterId === null) {
      return res.status(400).json({
        success: false,
        error: "user authentication required (provide x-auth-token or auth_token or x-auth-token)",
      });
    }

    if (Number(userId) !== requesterId) {
      return res.status(403).json({ success: false, error: "Доступ запрещён" });
    }

    const posts = await db.all(
      `
      SELECT *
      FROM posts
      WHERE user_id = ?
      ORDER BY 
        CASE WHEN scheduledAt IS NULL THEN 1 ELSE 0 END,  -- сначала те, где scheduledAt есть
        datetime(scheduledAt) ASC,                        -- сортировка по времени публикации
        id DESC                                           -- потом обычные по дате добавления
      `,
      userId
    );

    res.json(posts);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ получить пост по ID (теперь с проверкой владения)
router.get("/:id", async (req, res) => {
  try {
    const post = await db.get("SELECT * FROM posts WHERE id = ?", req.params.id);
    if (!post)
      return res.status(404).json({ success: false, error: "Пост не найден" });

    if (!await verifyOwnershipOrReject(post, req, res)) return;
    res.json(post);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ обновление поста (проверка владения)
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, url, scheduledAt } = req.body;
    const post = await db.get("SELECT * FROM posts WHERE id = ?", id);
    if (!post)
      return res.status(404).json({ success: false, error: "Пост не найден" });

    if (!await verifyOwnershipOrReject(post, req, res)) return;

    if (url && url !== post.url && post.url?.includes("/uploads/")) {
      const oldFilename = path.basename(post.url);
      const oldPath = path.join(uploadDir, oldFilename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    await db.run(
      `UPDATE posts SET title = ?, description = ?, url = ?, scheduledAt = ? WHERE id = ?`,
      [
        title ?? post.title,
        description ?? post.description,
        url === undefined ? post.url : url, // если undefined — оставляем старое, если null — пишем null
        scheduledAt ?? post.scheduledAt,
        id,
      ]
    );

    broadcast({ type: "posts_updated" });
    res.json({ success: true, message: "✅ Пост обновлён" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ удаление поста (проверка владения)
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const post = await db.get("SELECT * FROM posts WHERE id = ?", id);
    if (!post)
      return res.status(404).json({ success: false, error: "Пост не найден" });

    if (!await verifyOwnershipOrReject(post, req, res)) return;

    if (post.url?.includes("/uploads/")) {
      const filename = path.basename(post.url);
      const filePath = path.join(uploadDir, filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await db.run("DELETE FROM posts WHERE id = ?", id);
    broadcast({ type: "posts_updated" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ удалить только изображение у поста (проверка владения)
router.delete("/:id/image", async (req, res) => {
  try {
    const { id } = req.params;
    const post = await db.get("SELECT * FROM posts WHERE id = ?", id);
    if (!post)
      return res.status(404).json({ success: false, error: "Пост не найден" });

    if (!await verifyOwnershipOrReject(post, req, res)) return;

    if (post.url?.includes("/uploads/")) {
      const filename = path.basename(post.url);
      const filePath = path.join(uploadDir, filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await db.run("UPDATE posts SET url = NULL WHERE id = ?", id);
    broadcast({ type: "posts_updated" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ планирование (проверка владения)
router.post("/schedulePost/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduledAt } = req.body;
    const post = await db.get("SELECT * FROM posts WHERE id = ?", id);
    if (!post)
      return res.status(404).json({ success: false, error: "Пост не найден" });

    if (!await verifyOwnershipOrReject(post, req, res)) return;

    await db.run("UPDATE posts SET scheduledAt = ?, sent = 0 WHERE id = ?", [
      scheduledAt,
      id,
    ]);
    broadcast({ type: "posts_updated" });
    res.json({ success: true, message: "📅 Отправка запланирована" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/schedulePost/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const post = await db.get("SELECT * FROM posts WHERE id = ?", id);
    if (!post)
      return res.status(404).json({ success: false, error: "Пост не найден" });

    if (!await verifyOwnershipOrReject(post, req, res)) return;

    await db.run("UPDATE posts SET scheduledAt = NULL WHERE id = ?", id);
    broadcast({ type: "posts_updated" });
    res.json({ success: true, message: "⏹️ Отправка отменена" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ отправка поста вручную (проверка владения)
router.post("/sendPost/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const post = await db.get("SELECT * FROM posts WHERE id = ?", id);
    if (!post)
      return res.status(404).json({ success: false, error: "Пост не найден" });

    if (!await verifyOwnershipOrReject(post, req, res)) return;

    const user = await usersDb.get(
      "SELECT telegram_token, channel_id FROM users WHERE id = ?",
      post.user_id
    );
    if (!user)
      return res
        .status(400)
        .json({ success: false, error: "Пользователь не найден" });

    const bot = new TelegramBot(user.telegram_token, { polling: false });
    const caption = `*${post.title}*\n\n${post.description || ""}`;

    if (post.url?.includes("/uploads/")) {
      const filePath = path.join(uploadDir, path.basename(post.url));
      if (fs.existsSync(filePath)) {
        await bot.sendPhoto(user.channel_id, fs.createReadStream(filePath), {
          caption,
          parse_mode: "Markdown",
        });
        fs.unlinkSync(filePath);
      } else {
        await bot.sendPhoto(user.channel_id, post.url, {
          caption,
          parse_mode: "Markdown",
        });
      }
    } else if (post.url) {
      await bot.sendPhoto(user.channel_id, post.url, {
        caption,
        parse_mode: "Markdown",
      });
    } else {
      await bot.sendMessage(user.channel_id, caption, {
        parse_mode: "Markdown",
      });
    }

    await db.run("DELETE FROM posts WHERE id = ?", id);
    broadcast({ type: "posts_updated" });
    res.json({ success: true, message: "📤 Пост отправлен и удалён" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ генерация постов (главный эндпоинт) — доступен только владельцу userId/token
router.post("/generate-posts/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { prompt } = req.body; // <–– получаем prompt из тела запроса (необязательный)
    const requesterId = await getRequesterId(req);

    if (requesterId === null) {
      return res.status(400).json({
        success: false,
        error: "user authentication required (provide x-auth-token or auth_token or x-auth-token)",
      });
    }

    if (Number(userId) !== requesterId) {
      return res.status(403).json({ success: false, error: "Доступ запрещён" });
    }

    // получаем настройки пользователя
    const settings = await usersDb.get(
      `SELECT add_images, use_own_posts, use_other_channels AS use_channels, channels_list, use_sites, sites_list AS site_list
       FROM users WHERE id = ?`,
      userId
    );

    // передаём prompt в generatePostsService
    const posts = await generatePostsService(settings || {}, prompt);

    const formatted = posts.map((p, i) => ({
      id: p.id,
      title: p.title || `Пост #${i + 1}`,
      description: p.description || "Описание отсутствует",
      url: p.url || null,
    }));

    res.json({
      success: true,
      userId,
      posts: formatted,
    });
  } catch (err) {
    console.error("Ошибка в /generate-posts:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function attachEvents(server) {
  if (wss) return;
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  cron.schedule("*/10 * * * * *", async () => {
    try {
      const now = new Date().toISOString();
      const posts = await db.all(
        "SELECT * FROM posts WHERE sent = 0 AND scheduledAt IS NOT NULL AND scheduledAt <= ?",
        now
      );

      for (const post of posts) {
        const user = await usersDb.get(
          "SELECT telegram_token, channel_id FROM users WHERE id = ?",
          post.user_id
        );
        if (!user) continue;

        const bot = new TelegramBot(user.telegram_token, { polling: false });
        const caption = `*${post.title}*\n\n${post.description || ""}`;

        try {
          if (post.url?.includes("/uploads/")) {
            const filePath = path.join(uploadDir, path.basename(post.url));
            if (fs.existsSync(filePath)) {
              await bot.sendPhoto(user.channel_id, fs.createReadStream(filePath), {
                caption,
                parse_mode: "Markdown",
              });
              fs.unlinkSync(filePath);
            } else {
              await bot.sendPhoto(user.channel_id, post.url, {
                caption,
                parse_mode: "Markdown",
              });
            }
          } else if (post.url) {
            await bot.sendPhoto(user.channel_id, post.url, {
              caption,
              parse_mode: "Markdown",
            });
          } else {
            await bot.sendMessage(user.channel_id, caption, {
              parse_mode: "Markdown",
            });
          }

          await db.run("DELETE FROM posts WHERE id = ?", post.id);
        } catch (err) {
          console.error(`Ошибка при автоотправке поста #${post.id}:`, err.message);
        }
      }

      if (posts.length) broadcast({ type: "posts_updated" });
    } catch (err) {
      console.error("Ошибка CRON:", err.message);
    }
  });
}

export default router;
export { attachEvents };

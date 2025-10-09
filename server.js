import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import path from "path";
import { fileURLToPath } from "url";

import usersRouter from "./users.js";
import postsRouter, { attachEvents as attachPostsEvents } from "./posts.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 👉 добавь эту строку:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/uploads", express.static(path.join(__dirname, "uploads"))); // ✅ отдаём картинки

// Swagger setup
const swaggerDocument = YAML.load(path.join(__dirname, "openapi.yaml"));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use("/api/users", usersRouter);
app.use("/api/posts", postsRouter);

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

attachPostsEvents(server);

server.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}\n📘 Swagger UI: http://localhost:${PORT}/api-docs`)
);

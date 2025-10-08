import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import usersRouter from "./users.js";
import postsRouter, { attachEvents as attachPostsEvents } from "./posts.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/users", usersRouter);
app.use("/api/posts", postsRouter);

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

attachPostsEvents(server);

server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

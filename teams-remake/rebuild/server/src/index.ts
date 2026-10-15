import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import multer from "multer";
import { createHandler } from "graphql-http/lib/use/express";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/use/ws";
import { schema, verifyToken, recordUpload, canReadFile, type Ctx } from "./schema.js";
import { DATA_DIR } from "./db.js";

const PORT = Number(process.env.PORT ?? 4000);
const FILES_DIR = path.join(DATA_DIR, "files");
const CLIENT_DIST = path.resolve(import.meta.dirname, "../../client/dist");

const app = express();

app.use("/graphql", createHandler({
  schema,
  context: (req) => ({ mri: verifyToken(req.raw.headers.authorization) }) satisfies Ctx,
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});
app.post("/api/files", (req, res, next) => {
  const mri = verifyToken(req.headers.authorization);
  if (!mri) return res.status(401).json({ error: "Not signed in" });
  upload.single("file")(req, res, (err) => {
    if (err) return next(err);
    const f = req.file;
    if (!f) return res.status(400).json({ error: "No file" });
    const row = recordUpload(mri, f.filename, Buffer.from(f.originalname, "latin1").toString("utf8"), f.size, f.mimetype);
    res.json({ id: row!.id, name: row!.name, size: row!.size, mime: row!.mime, url: `/api/files/${row!.id}` });
  });
});
app.get("/api/files/:id", (req, res) => {
  const mri = verifyToken((req.query.token as string) ?? req.headers.authorization);
  const f = mri && canReadFile(mri, req.params.id);
  if (!f) return res.status(404).end();
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition",
    `${f.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.sendFile(path.join(FILES_DIR, f.id));
});

if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/graphql" });
useServer({
  schema,
  context: (ctx): Ctx => ({ mri: verifyToken(ctx.connectionParams?.token as string | undefined) }),
  onConnect: (ctx) => !!verifyToken(ctx.connectionParams?.token as string | undefined),
}, wss);

server.listen(PORT, () => console.log(`Teams rebuild server on http://localhost:${PORT}  (GraphQL + push at /graphql)`));

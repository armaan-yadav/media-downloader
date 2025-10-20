import morgan from "morgan";
import express from "express";
import path from "path";
import { errorMiddleware } from "./middlewares/error.middlewares.js";
import mediaRouter from "./routes/media.routes.js";

const app = express();

//middlewares
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//static files
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/", (req, res) => {
  res.send("Hello, World!");
});

app.use("/api/media", mediaRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    errorMiddleware,
  });
});

// Global error handler (must be last)
app.use(errorMiddleware);

export default app;

import { Router } from "express";
import { fetchMedia } from "../controllers/media.controllers.js";

const mediaRouter = Router();

mediaRouter.post("/download", fetchMedia);

export default mediaRouter;

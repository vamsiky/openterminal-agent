import { Router } from "express";
import { z } from "zod";
import { importPositions, listPositions } from "../quant/positions.js";

export const positionsRouter = Router();

// Holdings from a broker CSV (quant/positions.ts). Mounted behind requireApiKey.

positionsRouter.get("/", (_req, res) => {
  res.json(listPositions());
});

// A snapshot replace: the whole file is accepted or the whole file is rejected with its line errors.
positionsRouter.post("/import", (req, res) => {
  const body = z.object({ csv: z.string().max(1_000_000), filename: z.string().max(200).optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ errors: [{ line: 0, message: "send { csv, filename? } with the file's text" }] });
  const result = importPositions(body.data.csv, body.data.filename);
  if ("errors" in result) return res.status(400).json(result);
  res.json(result);
});

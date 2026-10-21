import { Router } from "express";
import { router as bulk } from "./bulk.js";
import { router as content, marketRouter as contentMarket } from "./content.js";
import { router as fundamentals } from "./fundamentals.js";
import { router as market, symbolRouter as marketSymbol } from "./market.js";
import { router as ownership, marketRouter as ownershipMarket } from "./ownership.js";

export const researchRouter = Router();

// Market-wide routes (/market/..., /screen) come first so the per-symbol
// routers' /:symbol never catches them.
researchRouter.use(market);
researchRouter.use(bulk);
researchRouter.use("/market", ownershipMarket);
researchRouter.use("/market", contentMarket);
researchRouter.use(fundamentals);
researchRouter.use(ownership);
researchRouter.use(content);
researchRouter.use(marketSymbol);

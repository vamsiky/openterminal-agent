import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, it } from "vitest";
import { researchRouter } from "./index.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/research", researchRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
});
afterAll(() => server.close());

it("mounts as an empty router: stubs answer nothing yet", async () => {
  expect((await fetch(`${base}/AAPL/profile`)).status).toBe(404);
  expect((await fetch(`${base}/market/gainers`)).status).toBe(404);
});

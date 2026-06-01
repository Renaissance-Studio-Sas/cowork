import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/server/routes/workspaces.ts — recursive workspace CRUD plus
// session creation. The slug-chain is carried in a splat (`*`) so a path like
// `/api/workspaces/HR/pay-contractors` reaches the nested workspace verbatim
// on the backend. Static prefixes (`from-plan`, `move/*`, `status/*`,
// `rename/*`, `files/*`, `sessions/*`, `sessions/:id/move/*`) are declared
// before the catch-all `/*` so they win.
export const workspaces = new Hono<{ Bindings: ProxyBindings }>();

// ---- collection ---------------------------------------------------------
workspaces.get("/", proxy); //                  GET  /api/workspaces
workspaces.post("/", proxy); //                 POST /api/workspaces
workspaces.post("/from-plan", proxy); //        POST /api/workspaces/from-plan

// ---- nested sub-resources (declared before catch-all) -------------------
workspaces.post("/move/*", proxy); //           POST   /api/workspaces/move/*
workspaces.patch("/status/*", proxy); //        PATCH  /api/workspaces/status/*
workspaces.patch("/rename/*", proxy); //        PATCH  /api/workspaces/rename/*
workspaces.get("/files/*", proxy); //           GET    /api/workspaces/files/*
workspaces.post("/sessions/*", proxy); //       POST   /api/workspaces/sessions/*
workspaces.post("/sessions/:id/move/*", proxy); // POST /api/workspaces/sessions/:id/move/*

// ---- single workspace by path -------------------------------------------
workspaces.get("/*", proxy); //                 GET    /api/workspaces/*
workspaces.post("/*", proxy); //                POST   /api/workspaces/* (create child)
workspaces.put("/*", proxy); //                 PUT    /api/workspaces/* (update brief)
workspaces.delete("/*", proxy); //              DELETE /api/workspaces/*

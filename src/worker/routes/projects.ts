import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/app/api/projects/** — project/task CRUD and session creation on
// the backend. Static segments (`from-plan`) are declared before the matching
// `:project` / `:task` param routes so they win.
export const projects = new Hono<{ Bindings: ProxyBindings }>();

// ---- collection ---------------------------------------------------------
projects.post("/", proxy); //           POST /api/projects
projects.post("/from-plan", proxy); //  POST /api/projects/from-plan

// ---- a single project ---------------------------------------------------
projects.get("/:project", proxy); //    GET    /api/projects/:project
projects.patch("/:project", proxy); //  PATCH  /api/projects/:project
projects.delete("/:project", proxy); // DELETE /api/projects/:project
projects.get("/:project/files", proxy); //    GET  /api/projects/:project/files
projects.post("/:project/sessions", proxy); // POST /api/projects/:project/sessions

// ---- tasks under a project ----------------------------------------------
projects.post("/:project/tasks", proxy); //           POST /api/projects/:project/tasks
projects.post("/:project/tasks/from-plan", proxy); // POST /api/projects/:project/tasks/from-plan

projects.get("/:project/tasks/:task", proxy); //    GET    /api/projects/:project/tasks/:task
projects.patch("/:project/tasks/:task", proxy); //  PATCH  /api/projects/:project/tasks/:task
projects.delete("/:project/tasks/:task", proxy); // DELETE /api/projects/:project/tasks/:task
projects.post("/:project/tasks/:task/sessions", proxy); // POST /api/projects/:project/tasks/:task/sessions

#!/usr/bin/env bun
/**
 * Dashboard HTTP server.
 *
 * - Hono app mounted at /api/*, PIN-gated via HMAC cookie.
 * - Serves the built Vite SPA from dashboard/web/dist in production. In dev
 *   the SPA is served by `vite` on :5173 and proxies /api → here.
 * - Reads config.toml for port/bind/pin.
 * - Opens the same SQLite DBs the daemon uses (WAL-safe concurrent readers).
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AgentStore } from "../../src/agents/store.ts";
import { AlertStore } from "../../src/alerts/store.ts";
import { AnnotationStore } from "../../src/annotate/store.ts";
import { BgJobStore } from "../../src/background/store.ts";
import { hardenHarnessPermissions } from "../../src/boot/harden-permissions.ts";
import { loadConfig } from "../../src/config/config.ts";
import { CreditStore } from "../../src/credits/store.ts";
import { CronStore } from "../../src/cron/store.ts";
import { GhostPrefsStore } from "../../src/ghost/prefs.ts";
import { ChatDb } from "../../src/imessage/db.ts";
import { AddressBook } from "../../src/sessions/address-book.ts";
import { ContactBook } from "../../src/sessions/contacts.ts";
import { StateStore } from "../../src/sessions/store.ts";
import { SpendLedger } from "../../src/spend/ledger.ts";
import { installLogSink } from "../../src/util/log-sink.ts";
import { loadOrCreateSecret } from "./auth.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { originGuard, securityHeaders } from "./middleware/csrf.ts";
import { errorHandler } from "./middleware/error.ts";
import { activityRoutes } from "./routes/activity.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { alertsRoutes } from "./routes/alerts.ts";
import { annotatePageRoutes, annotateSubmitRoutes } from "./routes/annotate.ts";
import { annotationsRoutes } from "./routes/annotations.ts";
import { authRoutes } from "./routes/auth.ts";
import { bgJobsRoutes } from "./routes/bgjobs.ts";
import { brownnoseRoutes } from "./routes/brownnose.ts";
import { configRoutes } from "./routes/config.ts";
import { contactsRoutes } from "./routes/contacts.ts";
import { creditsRoutes } from "./routes/credits.ts";
import { cronRoutes } from "./routes/cron.ts";
import { daemonRoutes } from "./routes/daemon.ts";
import { logsRoutes } from "./routes/logs.ts";
import { mediaRoutes } from "./routes/media.ts";
import { messagesRoutes } from "./routes/messages.ts";
import { metricsRoutes } from "./routes/metrics.ts";
import { modelsRoutes } from "./routes/models.ts";
import { orchestratorRoutes } from "./routes/orchestrator.ts";
import { payRoutes } from "./routes/pay.ts";
import { peopleRoutes } from "./routes/people.ts";
import { poolRoutes } from "./routes/pool.ts";
import { portalRoutes } from "./routes/portal.ts";
import { portalStaticRoutes } from "./routes/portalStatic.ts";
import { recallRoutes } from "./routes/recall.ts";
import { recoveryRoutes } from "./routes/recovery.ts";
import { sessionsRoutes } from "./routes/sessions.ts";
import { skillsRoutes } from "./routes/skills.ts";
import { LogTail } from "./services/logTail.ts";

/**
 * An annotated PNG arrives as base64 inside JSON. The route caps the decoded
 * image at 25 MB; base64 inflates by a third, plus the comment and rects.
 */
const ANNOTATION_BODY_LIMIT = 36 * 1024 * 1024;

const REPO_ROOT = resolve(import.meta.dir, "../..");
const WEB_DIST = resolve(REPO_ROOT, "dashboard/web/dist");
/** The USER portal SPA (bun run portal:build). Served on both listeners. */
const PORTAL_DIST = resolve(REPO_ROOT, "dashboard/user-web/dist");
const BRAND_MEDIA = resolve(REPO_ROOT, "dashboard/web/media");

async function main() {
  const config = loadConfig();
  hardenHarnessPermissions(REPO_ROOT, resolve(config.paths.data_dir));
  mkdirSync(config.paths.data_dir, { recursive: true });

  // Dashboard has its own log sink so daemon.log stays clean. Prefix makes
  // dashboard-originated lines easy to grep out later if needed.
  installLogSink(config.paths.data_dir, "[dash] ", "dashboard.log");
  console.log(`[dashboard] starting on ${config.dashboard.bind}:${config.dashboard.port}`);

  const secret = loadOrCreateSecret(config.paths.data_dir);
  const state = new StateStore(config.paths.data_dir);
  const crons = new CronStore(config.paths.data_dir);
  const agents = new AgentStore(config.paths.data_dir);
  const annotations = new AnnotationStore(config.paths.data_dir);
  const alerts = new AlertStore(config.paths.data_dir);
  const ghostPrefs = new GhostPrefsStore(config.paths.data_dir);
  const bgJobs = new BgJobStore(config.paths.data_dir);
  const addressBook = new AddressBook();
  const contacts = new ContactBook(config.contacts, addressBook);
  const chatDb = new ChatDb(config.paths.chat_db);
  // Generation-credit wallets + the runner that turns recorded payments
  // into OpenRouter limits (immediately after a webhook, and on a sweep).
  const credits = new CreditStore(config.paths.data_dir);

  const tail = new LogTail(resolve(config.paths.data_dir, "daemon.log"));
  tail.start();

  const app = new Hono();
  app.onError(errorHandler);
  app.use("*", securityHeaders());
  // State-changing API calls must come from our own origin. Registered
  // before any /api mount so the login route is covered too.
  app.use("/api/*", originGuard());
  // Nothing under /api legitimately carries a large body except annotation
  // uploads, which get their own, larger ceiling below. Reading a body
  // before authentication is where a request-size attack lands, so the
  // limit sits in front of every route.
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/api/a/*", bodyLimit({ maxSize: ANNOTATION_BODY_LIMIT }));
  app.use("/pay/*", bodyLimit({ maxSize: 1024 * 1024 }));

  // /api/auth is open (login doesn't have a cookie yet).
  app.route("/api/auth", authRoutes(secret));

  // Annotation link pages + submit endpoint — gated by the single-use token
  // baked into the URL, NOT by the dashboard PIN. Mounted before authMiddleware
  // so they stay reachable to the phone the model texted the link to.
  app.route("/a", annotatePageRoutes({ store: annotations, crons, contacts }));
  app.route("/api/a", annotateSubmitRoutes({ store: annotations, crons, contacts }));

  // User self-service portal — standing per-user links (HMAC-gated, no
  // PIN). Sent at the bottom of every proactive message so each user can
  // tune Edmund's proactive behavior for their own chat.
  app.route(
    "/u",
    portalRoutes({
      secret,
      prefs: ghostPrefs,
      crons,
      state,
      contacts,
      chatDb,
      config,
      credits,
      spaIndexHtml: PORTAL_DIST,
    }),
  );

  // The user portal's bundles + brand art (no token needed; nothing personal).
  app.route("/", portalStaticRoutes({ distDir: PORTAL_DIST, mediaDir: BRAND_MEDIA }));

  // Stripe webhook for generation credits. Signature-gated, not PIN-gated;
  // also mounted on the public listener below, which is where Stripe
  // actually reaches it. Here it serves `stripe listen --forward-to`.
  app.route("/pay", payRoutes({ config, store: credits, crons }));

  // Every other /api/* route requires auth.
  const api = new Hono();
  api.use("*", authMiddleware({ secret }));
  api.route("/sessions", sessionsRoutes({ state, crons, agents, contacts, chatDb }));
  api.route(
    "/brownnose",
    brownnoseRoutes({ state, prefs: ghostPrefs, contacts, chatDb, config, crons }),
  );
  api.route("/cron", cronRoutes({ crons, contacts, chatDb }));
  api.route("/agents", agentsRoutes({ agents, contacts, chatDb }));
  api.route("/bgjobs", bgJobsRoutes({ bgJobs, contacts, chatDb }));
  api.route("/logs", logsRoutes({ tail }));
  api.route("/config", configRoutes());
  api.route("/daemon", daemonRoutes());
  api.route("/media", mediaRoutes({ state, contacts, chatDb }));
  api.route("/messages", messagesRoutes({ state, chatDb, contacts }));
  api.route("/activity", activityRoutes({ state, crons, agents, contacts, chatDb, tail }));
  api.route("/annotations", annotationsRoutes({ store: annotations, contacts, chatDb }));
  api.route("/alerts", alertsRoutes({ alerts }));
  api.route("/skills", skillsRoutes({ config, repoRoot: REPO_ROOT }));
  api.route("/models", modelsRoutes());
  api.route("/orchestrator", orchestratorRoutes({ repoRoot: REPO_ROOT }));
  api.route("/recall", recallRoutes({ config, repoRoot: REPO_ROOT }));
  api.route("/recovery", recoveryRoutes({ state, contacts, chatDb, config }));
  api.route("/people", peopleRoutes({ state, contacts, chatDb, config, repoRoot: REPO_ROOT }));
  api.route("/contacts", contactsRoutes());
  api.route("/pool", poolRoutes({ config }));
  api.route("/metrics", metricsRoutes({ ledger: new SpendLedger(config.paths.data_dir) }));
  api.route("/credits", creditsRoutes({ config, store: credits, state, contacts, chatDb }));
  app.route("/api", api);

  // SPA fallback — serve built assets. In dev the user hits Vite on :5173.
  const distExists = existsSync(WEB_DIST);
  app.get("*", async (c) => {
    if (!distExists) {
      return c.text(
        "dashboard web assets not built — run `bun run dashboard:build` or use `bun run dashboard:dev`",
        503,
      );
    }
    const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
    const filePath = resolve(WEB_DIST, `.${reqPath}`);
    if (existsSync(filePath) && filePath.startsWith(WEB_DIST)) {
      return new Response(Bun.file(filePath));
    }
    return new Response(Bun.file(resolve(WEB_DIST, "index.html")), {
      headers: { "Content-Type": "text/html" },
    });
  });

  const server = Bun.serve({
    hostname: config.dashboard.bind,
    port: config.dashboard.port,
    fetch: app.fetch,
    idleTimeout: 0,
  });
  console.log(`[dashboard] ready at http://${config.dashboard.bind}:${config.dashboard.port}`);
  console.log(`[dashboard] web dist: ${distExists ? WEB_DIST : "(missing — dev mode only)"}`);

  // ── Public-only listener ─────────────────────────────────────────────
  // What the standing cloudflared tunnel points at. Serves EXCLUSIVELY the
  // token-gated user surfaces — the per-user portal and annotate links —
  // and a bare 404 for anything else. The PIN dashboard, API, and SPA are
  // not mounted here and can never be reached through the tunnel. Bound to
  // loopback: the only way in from outside is the tunnel itself.
  const pub = new Hono();
  pub.onError(errorHandler);
  pub.use("*", securityHeaders());
  pub.use("*", async (c, next) => {
    await next();
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Cache-Control", "no-store"); // pages carry personal data
  });
  pub.use("/api/a/*", bodyLimit({ maxSize: ANNOTATION_BODY_LIMIT }));
  pub.use("/pay/*", bodyLimit({ maxSize: 1024 * 1024 }));
  pub.use("/u/*", bodyLimit({ maxSize: 64 * 1024 }));
  pub.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
  pub.route("/", portalStaticRoutes({ distDir: PORTAL_DIST, mediaDir: BRAND_MEDIA }));
  pub.route(
    "/u",
    portalRoutes({
      secret,
      prefs: ghostPrefs,
      crons,
      state,
      contacts,
      chatDb,
      config,
      credits,
      spaIndexHtml: PORTAL_DIST,
    }),
  );
  pub.route("/a", annotatePageRoutes({ store: annotations, crons, contacts }));
  pub.route("/api/a", annotateSubmitRoutes({ store: annotations, crons, contacts }));
  // Stripe's webhook target: <external_url>/pay/stripe. Verified by
  // signature; an unset keys.stripe_webhook_secret rejects every call.
  pub.route("/pay", payRoutes({ config, store: credits, crons }));
  pub.notFound((c) => c.text("not found", 404));
  const publicServer = Bun.serve({
    hostname: "127.0.0.1",
    port: config.dashboard.public_port,
    fetch: pub.fetch,
    idleTimeout: 0,
  });
  console.log(
    `[dashboard] public user listener (portal/annotate only) on 127.0.0.1:${config.dashboard.public_port}`,
  );

  const shutdown = () => {
    console.log("[dashboard] shutting down");
    tail.stop();
    server.stop();
    publicServer.stop();
    crons.close();
    state.close();
    annotations.close();
    alerts.close();
    bgJobs.close();
    chatDb.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[dashboard] fatal", err);
  process.exit(1);
});

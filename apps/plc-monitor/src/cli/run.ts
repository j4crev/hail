import { ReceiverLifecycleClient, cleanMonitorReceiver } from "../receiver-lifecycle.js";
import { SourceAdmission } from "../admission.js";
import { createProviderRegistrationApi } from "../provider-registration.js";
import { EnrollmentProviders } from "../providers.js";
import { IncidentCapabilities } from "../incident-capabilities.js";
import { IncidentService, createIncidentApi } from "../incidents.js";
import { incidentStyles } from "../incident-page.js";
import { MonitorDatabase } from "../database.js";
import { PlcMonitor } from "../monitor.js";
import { MonitorNotifier, PinnedHttpsAlertTransport } from "../notifier.js";
import { BoundedMonitorPlcClient } from "../plc.js";
import { MonitorSigner } from "../signing.js";
import { createMonitorEnrollmentApi, monitorEnrollmentConfig } from "../enrollment.js";

if (!Bun.env.DATABASE_URL || !Bun.env.PLC_DIRECTORY_URL || !Bun.env.MONITOR_PRIVATE_KEY_FILE) {
  throw new Error("DATABASE_URL, PLC_DIRECTORY_URL and MONITOR_PRIVATE_KEY_FILE are required");
}
const enrollment = monitorEnrollmentConfig(Bun.env);
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
await database.migrate();
const signer = await MonitorSigner.fromPrivateFile(Bun.env.MONITOR_PRIVATE_KEY_FILE);
const plc = new BoundedMonitorPlcClient(Bun.env.PLC_DIRECTORY_URL);
const monitor = new PlcMonitor(database.sql, plc);
const incidents = Bun.env.MONITOR_INCIDENT_ORIGIN
  ? new IncidentCapabilities(database.sql, signer, Bun.env.MONITOR_INCIDENT_ORIGIN) : undefined;
if (incidents && (!enrollment || Bun.env.PLC_DIRECTORY_URL !== "https://plc.directory"))
  throw new Error("Public incidents require the configured private API listener and canonical PLC directory");
const incidentApi = incidents ? createIncidentApi(incidents, new IncidentService(database.sql, monitor, plc), {
  javascript: await Bun.file(new URL("../../dist-browser/incident-browser.js", import.meta.url)).text(), stylesheet: incidentStyles,
}) : undefined;
const receiver = new ReceiverLifecycleClient(signer);
const notifier = new MonitorNotifier(database.sql, signer, new PinnedHttpsAlertTransport(), () => new Date(), incidents);
if (enrollment) {
  const providers = new EnrollmentProviders(database.sql);
  const registration = createProviderRegistrationApi(providers, signer, enrollment.monitorOrigin, undefined, enrollment.apiOrigin);
  const api = createMonitorEnrollmentApi(enrollment, monitor, signer, providers);
  const admission = new SourceAdmission();
  Bun.serve({ hostname: enrollment.hostname, port: enrollment.port, maxRequestBodySize: 32_768,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/incidents/") && incidentApi) return incidentApi.fetch(request);
      const source = Bun.env.MONITOR_TRUST_PROXY === "true"
        ? request.headers.get("X-Hail-Monitor-Client-IP") ?? "unknown"
        : server.requestIP(request)?.address ?? "unknown";
      if (!admission.take(source, path === "/api/v1/providers/register"))
        return Response.json({ error: "Source request limit reached" }, { status: 429,
          headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
      return path === "/api/v1/providers/register" ? registration.fetch(request) : api.fetch(request);
    },
  });
}
console.info(JSON.stringify({ event: "monitor-started", monitorDidKey: signer.publicDidKey,
  deploymentProfile: Bun.env.MONITOR_DEPLOYMENT_PROFILE ?? "unspecified", enrollmentApi: enrollment ? "reduced-assurance-alpha-v1" : "disabled" }));

let polling = false;
let notifying = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const result = await monitor.poll();
    if (result.state !== "current" || result.alerts) console.info(JSON.stringify({ event: "monitor-poll", ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: "monitor-poll-error", error: error instanceof Error ? error.message : "unknown" }));
  } finally { polling = false; }
}
async function notify() {
  if (notifying) return;
  notifying = true;
  try {
    const cleanup = await cleanMonitorReceiver(database.sql, receiver);
    if (cleanup !== "idle") console.info(JSON.stringify({ event: "monitor-receiver-cleanup", outcome: cleanup }));
    const outcome = await notifier.sendOne();
    if (outcome !== "idle") console.info(JSON.stringify({ event: "monitor-notify", outcome }));
  } catch (error) {
    console.error(JSON.stringify({ event: "monitor-notify-error", error: error instanceof Error ? error.message : "unknown" }));
  } finally { notifying = false; }
}
await poll();
await notify();
setInterval(() => { void poll(); }, 240_000);
setInterval(() => { void notify(); }, 5_000);

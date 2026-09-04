import { AgentsPage } from "@/pages/AgentsPage";
import { AlertsPage } from "@/pages/AlertsPage";
import { AnnotationsPage } from "@/pages/AnnotationsPage";
import { BgJobsPage } from "@/pages/BgJobsPage";
import { BrownNoseDetailPage } from "@/pages/BrownNoseDetailPage";
import { BrownNosePage } from "@/pages/BrownNosePage";
import { ContactsPage } from "@/pages/ContactsPage";
import { CreditsPage } from "@/pages/CreditsPage";
import { CronPage } from "@/pages/CronPage";
import { DaemonPage } from "@/pages/DaemonPage";
import { LoginPage } from "@/pages/LoginPage";
import { LogsPage } from "@/pages/LogsPage";
import { MediaPage } from "@/pages/MediaPage";
import { ModelsPage } from "@/pages/ModelsPage";
import { OrchestratorEditorPage } from "@/pages/OrchestratorEditorPage";
import { OrchestratorPage } from "@/pages/OrchestratorPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { PeoplePage } from "@/pages/PeoplePage";
import { RecallPage } from "@/pages/RecallPage";
import { RecoveryPage } from "@/pages/RecoveryPage";
import { SessionDetailPage } from "@/pages/SessionDetailPage";
import { SessionsPage } from "@/pages/SessionsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./AppShell";
import { RequireAuth } from "./RequireAuth";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/:key", element: <SessionDetailPage /> },
      { path: "cron", element: <CronPage /> },
      { path: "brownnose", element: <BrownNosePage /> },
      { path: "brownnose/:key", element: <BrownNoseDetailPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "bgjobs", element: <BgJobsPage /> },
      { path: "annotations", element: <AnnotationsPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "recall", element: <RecallPage /> },
      { path: "alerts", element: <AlertsPage /> },
      { path: "credits", element: <CreditsPage /> },
      { path: "recovery", element: <RecoveryPage /> },
      { path: "people", element: <PeoplePage /> },
      { path: "contacts", element: <ContactsPage /> },
      { path: "logs", element: <LogsPage /> },
      { path: "media", element: <MediaPage /> },
      { path: "models", element: <ModelsPage /> },
      { path: "orchestrator", element: <OrchestratorPage /> },
      { path: "orchestrator/new", element: <OrchestratorEditorPage /> },
      { path: "orchestrator/:key", element: <OrchestratorEditorPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/:section", element: <SettingsPage /> },
      { path: "daemon", element: <DaemonPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

const AppShell = lazy(() => import('./components/AppShell'));
const ArcPage = lazy(() => import('./pages/ArcPage'));
const CanonPage = lazy(() => import('./pages/CanonPage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const ChatIndexPage = lazy(() => import('./pages/ChatIndexPage'));
const ChatHistoryPage = lazy(() => import('./pages/ChatHistoryPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const EpisodeEditorPage = lazy(() => import('./pages/EpisodeEditorPage'));
const EpisodesPage = lazy(() => import('./pages/EpisodesPage'));
const ImprovementsPage = lazy(() => import('./pages/ImprovementsPage'));
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ProjectWizardPage = lazy(() => import('./pages/ProjectWizardPage'));

export default function App() {
  return (
    <Suspense fallback={<div className="state-box" role="status">화면을 여는 중</div>}>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<ProjectWizardPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/projects/:projectId" element={<AppShell />}>
          <Route index element={<Navigate to="episodes" replace />} />
          <Route path="episodes" element={<EpisodesPage />} />
          <Route path="episodes/:episodeId" element={<EpisodeEditorPage />} />
          <Route path="canon" element={<CanonPage />} />
          <Route path="chat" element={<ChatIndexPage />} />
          <Route path="chat/history" element={<ChatHistoryPage />} />
          <Route path="chat/:threadId" element={<ChatPage />} />
          <Route path="arc" element={<ArcPage />} />
          <Route path="improvements" element={<ImprovementsPage />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </Suspense>
  );
}

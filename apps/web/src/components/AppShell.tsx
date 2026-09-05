import { useQuery } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  BookOpenText,
  ChevronDown,
  GitBranch,
  Library,
  ListTree,
  Menu,
  MessageCircle,
  Plus,
  Settings,
  Sparkles,
  Scale,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { cx } from '../lib';
import { ErrorState, IconButton, Spinner } from './Ui';

const nav = [
  { slug: 'episodes', label: '회차', shortLabel: '회차', icon: BookOpenText },
  { slug: 'chat', label: 'AI 채팅', shortLabel: 'AI 채팅', icon: MessageCircle },
  { slug: 'canon', label: '정사·설정', shortLabel: '정사', icon: Library },
  { slug: 'arc', label: '현재 아크', shortLabel: '아크', icon: GitBranch },
  { slug: 'improvements', label: '개선점', shortLabel: '개선점', icon: Sparkles },
] as const;

export default function AppShell() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const projectQuery = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api.projects.get(projectId),
    enabled: Boolean(projectId),
  });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const isEditor = /\/episodes\/[^/]+/.test(location.pathname);
  const isComparison = location.pathname.endsWith('/compare');
  const isChat = location.pathname.endsWith('/chat');
  const focused = isEditor || isComparison;

  if (projectQuery.isPending) return <Spinner label="프로젝트를 여는 중" />;
  if (projectQuery.isError || !projectQuery.data) {
    return <ErrorState message="프로젝트를 불러오지 못했습니다." onRetry={() => projectQuery.refetch()} />;
  }

  const project = projectQuery.data;

  return (
    <div className={cx('app-shell', focused && 'focused-shell')}>
      <aside className="desktop-sidebar" aria-label="프로젝트 메뉴">
        <NavLink to="/projects" className="brand-lockup" aria-label="파라노벨 프로젝트 목록">
          <span className="brand-mark"><ListTree className="size-5" /></span>
          <span>PARANOVEL</span>
        </NavLink>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="project-switcher" aria-label={`프로젝트 전환, 현재 ${project.title}`}>
              <span className="min-w-0 text-left">
                <span className="block text-[11px] font-semibold uppercase tracking-[.14em] text-muted">현재 프로젝트</span>
                <span className="mt-1 block truncate font-semibold text-ink">{project.title}</span>
              </span>
              <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="dropdown-content" sideOffset={8} align="start">
              {(projectsQuery.data ?? []).map((item) => (
                <DropdownMenu.Item
                  key={item.id}
                  className="dropdown-item"
                  onSelect={() => navigate(`/projects/${item.id}/episodes`)}
                >
                  {item.title}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item className="dropdown-item" onSelect={() => navigate('/projects/new')}>
                <Plus className="size-4" /> 새 프로젝트
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <nav className="side-nav">
          {nav.map(({ slug, label, icon: Icon }) => (
            <NavLink
              key={slug}
              to={`/projects/${projectId}/${slug}`}
              className={({ isActive }) => cx('side-nav-item', isActive && 'active')}
              aria-label={label}
              title={label}
            >
              <Icon className="size-[18px]" aria-hidden="true" />
              <span className="side-nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto">
          <NavLink to="/compare" className="side-nav-item" aria-label="두 원고 비교" title="두 원고 비교">
            <Scale className="size-[18px]" aria-hidden="true" /> <span className="side-nav-label">두 원고 비교</span>
          </NavLink>
          <NavLink to={`/projects/${projectId}/settings`} className="side-nav-item" aria-label="프로젝트 설정" title="프로젝트 설정">
            <Settings className="size-[18px]" aria-hidden="true" /> <span className="side-nav-label">프로젝트 설정</span>
          </NavLink>
        </div>
      </aside>

      <header className={cx('mobile-topbar', focused && 'focused-topbar')}>
        {focused ? (
          <IconButton label="이전 화면" onClick={() => navigate(-1)}>
            <span aria-hidden="true" className="text-xl">←</span>
          </IconButton>
        ) : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <IconButton label="프로젝트 전환">
                <Menu className="size-5" aria-hidden="true" />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="dropdown-content" sideOffset={8} align="start">
                <DropdownMenu.Item className="dropdown-item" onSelect={() => navigate('/projects')}>
                  모든 프로젝트
                </DropdownMenu.Item>
                <DropdownMenu.Item className="dropdown-item" onSelect={() => navigate('/compare')}>
                  <Scale className="size-4" /> 두 원고 비교
                </DropdownMenu.Item>
                {(projectsQuery.data ?? []).map((item) => (
                  <DropdownMenu.Item
                    key={item.id}
                    className="dropdown-item"
                    onSelect={() => navigate(`/projects/${item.id}/episodes`)}
                  >
                    {item.title}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-bold text-ink">{project.title}</p>
        </div>
        <NavLink className="icon-button" to={`/projects/${projectId}/settings`} aria-label="프로젝트 설정">
          <Settings className="size-5" aria-hidden="true" />
        </NavLink>
      </header>

      <main className={cx('shell-main', focused && 'shell-main-focused', isChat && 'shell-main-chat')}>
        <Outlet context={{ project }} />
      </main>

      {!focused ? (
        <nav className="mobile-tabbar" aria-label="프로젝트 메뉴">
          {nav.map(({ slug, label, shortLabel, icon: Icon }) => (
            <NavLink
              key={slug}
              to={`/projects/${projectId}/${slug}`}
              className={({ isActive }) => cx('mobile-tab', isActive && 'active')}
            >
              <Icon className="size-5" aria-hidden="true" />
              <span>{shortLabel ?? label}</span>
            </NavLink>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

export interface ProjectOutletContext {
  project: import('../types').Project;
}

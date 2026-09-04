import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookOpenText, Ellipsis, Feather, Plus, Scale, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import { formatRelativeDate } from '../lib';
import type { Project } from '../types';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, IconButton, SkeletonCards } from '../components/Ui';

export default function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<Project | null>(null);
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.projects.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setDeleting(null);
    },
  });

  return (
    <div className="landing-page">
      <header className="landing-header">
        <Link to="/projects" className="brand-lockup text-ink" aria-label="파라노벨 홈">
          <span className="brand-mark"><Feather className="size-5" /></span>
          <span>PARANOVEL</span>
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/compare" className="icon-button sm:button sm:button-secondary sm:button-md" aria-label="두 원고 비교"><Scale className="size-4" /><span className="hidden sm:inline">두 원고 비교</span></Link>
          <Button onClick={() => navigate('/projects/new')}><Plus className="size-4" aria-hidden="true" /><span className="hidden xs:inline">새 프로젝트</span><span className="xs:hidden">새로 만들기</span></Button>
        </div>
      </header>

      <main className="landing-main">
        <div className="page-heading-row">
          <div>
            <p className="eyebrow">나의 집필실</p>
            <h1 className="display-title">이야기를 이어가세요</h1>
            <p className="page-lead">설정과 기억을 잃지 않는 AI와 함께 씁니다.</p>
          </div>
        </div>

        {projectsQuery.isPending ? <SkeletonCards count={3} /> : null}
        {projectsQuery.isError ? (
          <ErrorState message={messageOf(projectsQuery.error)} onRetry={() => projectsQuery.refetch()} />
        ) : null}
        {projectsQuery.data?.length === 0 ? (
          <EmptyState
            icon={<BookOpenText className="size-8" />}
            title="첫 이야기를 시작해 볼까요?"
            description="로그라인과 장르를 알려주면 AI가 제목과 세계를 함께 구체화해요."
            action={<Button onClick={() => navigate('/projects/new')}><Plus className="size-4" /> 프로젝트 만들기</Button>}
          />
        ) : null}

        {projectsQuery.data?.length ? (
          <section className="card-grid" aria-label="프로젝트 목록">
            {projectsQuery.data.map((project) => (
              <article key={project.id} className="project-card">
                <Link to={`/projects/${project.id}/episodes`} className="project-card-link">
                  <div className="flex items-start justify-between gap-3">
                    <Badge tone="plum">{project.genreTags[0] ?? '장르 미정'}</Badge>
                    <span className="text-xs text-muted">{formatRelativeDate(project.updatedAt)}</span>
                  </div>
                  <h2>{project.title}</h2>
                  <p>{project.logline}</p>
                  <div className="mt-auto flex items-center gap-2 pt-6 text-xs font-medium text-muted">
                    <BookOpenText className="size-4" aria-hidden="true" />
                    {project.lastEpisodeNumber ? `${project.lastEpisodeNumber}화까지 집필` : '아직 작성된 회차 없음'}
                  </div>
                </Link>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <IconButton label={`${project.title} 메뉴`} className="project-menu-button">
                      <Ellipsis className="size-5" aria-hidden="true" />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={6}>
                      <DropdownMenu.Item
                        className="dropdown-item text-red-700"
                        onSelect={() => setDeleting(project)}
                      >
                        <Trash2 className="size-4" /> 프로젝트 삭제
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </article>
            ))}
          </section>
        ) : null}
      </main>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="프로젝트를 삭제할까요?"
        description={`‘${deleting?.title ?? ''}’의 회차, 정사, 아크와 프로젝트 개선점이 함께 삭제되며 되돌릴 수 없습니다.`}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        busy={deleteMutation.isPending}
      />
      {deleteMutation.isError ? <p className="sr-only" role="alert">{messageOf(deleteMutation.error)}</p> : null}
    </div>
  );
}

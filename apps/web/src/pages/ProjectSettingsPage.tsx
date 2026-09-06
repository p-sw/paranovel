import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseZap, Settings, Trash2 } from 'lucide-react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import type { ProjectOutletContext } from '../components/AppShell';
import { Button, ConfirmDialog, FieldError } from '../components/Ui';

export default function ProjectSettingsPage() {
  const { projectId = '' } = useParams();
  const { project } = useOutletContext<ProjectOutletContext>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState(project.title);
  const [logline, setLogline] = useState(project.logline);
  const [genres, setGenres] = useState(project.genreTags.join(', '));
  const [writingDirection, setWritingDirection] = useState(project.writingDirection ?? '');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setTitle(project.title); setLogline(project.logline); setGenres(project.genreTags.join(', ')); setWritingDirection(project.writingDirection ?? ''); }, [project]);
  const updateMutation = useMutation({ mutationFn: () => api.projects.update(projectId, { expectedRevision: project.revision, title: title.trim(), logline: logline.trim(), genreTags: genres.split(',').map((item) => item.trim()).filter(Boolean), writingDirection }), onSuccess: (updated) => { queryClient.setQueryData(['projects', projectId], updated); queryClient.invalidateQueries({ queryKey: ['projects'] }); setError(''); }, onError: (reason) => setError(messageOf(reason)) });
  const deleteMutation = useMutation({ mutationFn: () => api.projects.remove(projectId), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate('/projects', { replace: true }); }, onError: (reason) => setError(messageOf(reason)) });
  const reindexMutation = useMutation({ mutationFn: () => api.memory.reindex(projectId), onError: (reason) => setError(messageOf(reason)) });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!title.trim() || !logline.trim()) return setError('제목과 로그라인을 입력해 주세요.'); updateMutation.mutate(); };
  return <div className="page-container page-narrow"><header className="page-heading-row"><div><p className="eyebrow">프로젝트 관리</p><h1 className="section-title">프로젝트 설정</h1></div></header><form className="form-card" onSubmit={submit}><div className="form-card-heading"><Settings className="size-5" /><div><h2>기본 정보</h2><p>변경 내용은 이후 AI 집필부터 반영됩니다.</p></div></div><div className="mt-6 space-y-5"><div><label className="field-label" htmlFor="settings-title">소설 제목</label><input id="settings-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} /></div><div><label className="field-label" htmlFor="settings-logline">로그라인</label><textarea id="settings-logline" className="input" value={logline} onChange={(event) => setLogline(event.target.value)} /></div><div><label className="field-label" htmlFor="settings-genres">장르 태그</label><input id="settings-genres" className="input" value={genres} onChange={(event) => setGenres(event.target.value)} /><p className="field-hint">쉼표로 구분해 주세요.</p></div><div><label className="field-label" htmlFor="settings-writing-direction">작문 디렉션</label><textarea id="settings-writing-direction" className="input" rows={8} maxLength={20000} value={writingDirection} onChange={(event) => setWritingDirection(event.target.value)} /><p className="field-hint">시점·시제·문체·호흡, 묘사와 대화 방식처럼 AI가 계속 지켜야 할 집필 원칙을 적어 주세요.</p></div></div><FieldError>{error}</FieldError><div className="action-row mt-6"><Button type="submit" busy={updateMutation.isPending}>변경 저장</Button></div></form><section className="form-card settings-action-card"><div className="form-card-heading"><DatabaseZap className="size-5" /><div><h2>검색 기억 재색인</h2><p>검색 결과가 오래되었거나 누락될 때 정사와 회차 기억을 다시 정리합니다.</p></div></div><Button variant="secondary" busy={reindexMutation.isPending} onClick={() => reindexMutation.mutate()}>{reindexMutation.isSuccess ? '재색인 완료' : '다시 색인'}</Button></section><section className="danger-zone"><div><h2>프로젝트 삭제</h2><p>모든 회차와 기억을 영구 삭제합니다.</p></div><Button variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /> 삭제</Button></section><ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="프로젝트를 완전히 삭제할까요?" description={`‘${project.title}’의 회차, 정사, 아크와 프로젝트 개선점이 모두 삭제되며 복구할 수 없습니다.`} onConfirm={() => deleteMutation.mutate()} busy={deleteMutation.isPending} /></div>;
}

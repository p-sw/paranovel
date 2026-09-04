import type { AiPhase, CanonCategory } from './types';

export const GENRE_SUGGESTIONS = [
  '현대판타지',
  '로맨스판타지',
  '무협',
  '헌터물',
  '회귀',
  '빙의',
  '미스터리',
  'SF',
  '드라마',
];

export const CANON_LABELS: Record<CanonCategory, string> = {
  CHARACTER: '인물',
  LOCATION: '장소',
  ORGANIZATION: '조직',
  ABILITY: '능력',
  RULE: '규칙',
  TIMELINE: '연표',
  OTHER: '기타',
};

export const AI_PHASE_LABELS: Record<AiPhase, string> = {
  idle: '준비됨',
  retrieving: '기억을 불러오는 중',
  writing: '초안을 쓰는 중',
  checking: '일관성을 확인하는 중',
  repairing: '충돌을 바로잡는 중',
  done: '검토 완료',
  error: '생성 실패',
  cancelled: '생성 중단됨',
};

export function formatRelativeDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const diff = Date.now() - date.valueOf();
  const minutes = Math.max(0, Math.floor(diff / 60_000));
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(date);
}

export function characterCount(text: string): string {
  return new Intl.NumberFormat('ko-KR').format(text.length);
}

export function createIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

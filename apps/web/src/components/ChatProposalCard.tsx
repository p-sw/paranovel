import type { ChatProposal } from '@paranovel/contracts';
import { Check, Trash2 } from 'lucide-react';
import { Badge, Button } from './Ui';

const kindLabels: Record<ChatProposal['kind'], string> = {
  PROJECT: '프로젝트 정보', CANON: '설정', ARC: '아크', IMPROVEMENT: '개선점',
};
const operationLabels: Record<ChatProposal['operation'], string> = {
  CREATE: '추가', UPDATE: '수정', DELETE: '삭제',
};
const fieldLabels: Record<string, string> = {
  title: '제목', name: '이름', logline: '로그라인', genreTags: '장르', details: '상세 설정',
  defaultTargetChars: '목표 글자 수', category: '분류', aliases: '다른 이름', content: '내용',
  metadata: '추가 정보', status: '상태', startEpisodeNumber: '시작 회차', endEpisodeNumber: '마지막 회차',
  startEpisode: '시작 회차', endEpisode: '마지막 회차', goal: '목표', conflict: '갈등',
  twistPlan: '반전 계획', reversalPlan: '주요 전개', rule: '규칙', rationale: '이유',
  tags: '태그', beforeExample: '수정 전 예시', afterExample: '수정 후 예시', active: '사용 여부',
};
const ignoredFields = new Set([
  'id', 'projectId', 'revision', 'expectedRevision', 'createdAt', 'updatedAt', 'deletedAt',
  'sourceEpisodeId', 'duplicateOfId', 'conflictsWithIds', 'source', 'scope', 'confidence',
  'nextEpisodeNumber', 'lastEpisodeNumber',
]);
const valueLabels: Record<string, string> = {
  ACTIVE: '사용 중', PENDING: '검토 대기', ACCEPTED: '확정', REJECTED: '제외',
  PLANNED: '계획됨', COMPLETE: '완료', ARCHIVED: '보관됨',
  CHARACTER: '인물', CHARACTER_APPEARANCE: '인물 외형', LOCATION: '장소', ORGANIZATION: '조직', ABILITY: '능력',
  RULE: '규칙', TIMELINE: '연표', OTHER: '기타', STYLE: '문체',
};

function displayValue(value: unknown, field?: string): string {
  if (value === null || value === undefined || value === '') return '없음';
  if (typeof value === 'boolean') return field === 'active' ? (value ? '사용' : '사용 안 함') : String(value);
  if (typeof value === 'string') return field === 'status' || field === 'category' ? valueLabels[value] ?? value : value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => displayValue(item, field === 'reversalPlan' ? 'arcBeat' : undefined)).join('\n') : '없음';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (field === 'arcBeat') return `${record.episode}화: ${displayValue(record.description)}`;
    return Object.entries(record)
      .map(([key, item]) => `${key}: ${displayValue(item)}`).join('\n') || '없음';
  }
  return String(value);
}

function ChangeDetails({ before, after }: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((key) => !ignoredFields.has(key))
    .filter((key) => !before || !after || JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return <dl className="chat-change-list">
    {keys.map((key) => <div key={key}>
      <dt>{fieldLabels[key] ?? key}</dt>
      <dd className={before && after ? 'chat-change-pair' : ''}>
        {before ? <div><span className="chat-change-label">현재 내용</span><p>{displayValue(before[key], key)}</p></div> : null}
        {after ? <div><span className="chat-change-label">적용할 내용</span><p>{displayValue(after[key], key)}</p></div> : null}
      </dd>
    </div>)}
  </dl>;
}

export function ChatProposalCard({ proposal, onApply, busy, disabled, error }: {
  proposal: ChatProposal;
  onApply: () => void;
  busy: boolean;
  disabled: boolean;
  error?: string;
}) {
  const applied = proposal.status === 'APPLIED';
  return <section className="chat-proposal" aria-label={`${proposal.title} 변경안`}>
    <div className="flex flex-wrap items-center gap-2">
      <Badge>{kindLabels[proposal.kind]}</Badge>
      <Badge tone={proposal.operation === 'DELETE' ? 'danger' : 'plum'}>{operationLabels[proposal.operation]} 제안</Badge>
      {applied ? <Badge tone="sage"><Check className="mr-1 size-3" />적용 완료</Badge> : null}
    </div>
    <h3 className="mt-3 font-bold text-ink">{proposal.title}</h3>
    <ChangeDetails before={proposal.before} after={proposal.after} />
    {proposal.operation === 'DELETE' ? <p className="mt-3 text-sm font-semibold text-red-700">적용하면 이 항목이 삭제됩니다.</p> : null}
    {proposal.effects.map((effect, index) => <div key={index} className="chat-proposal-effect">
      <p className="text-sm font-bold text-amber-950">{effect.label}</p>
      <ChangeDetails before={effect.before} after={effect.after} />
    </div>)}
    {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
    {!applied ? <div className="mt-4 flex justify-end">
      <Button variant={proposal.operation === 'DELETE' ? 'danger' : 'primary'} busy={busy} disabled={disabled} onClick={onApply}>
        {proposal.operation === 'DELETE' ? <Trash2 className="size-4" /> : <Check className="size-4" />}
        {proposal.operation === 'DELETE' ? '삭제 적용' : '변경안 적용'}
      </Button>
    </div> : null}
  </section>;
}

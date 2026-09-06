import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type { ContinuityIssue, StreamResult } from '../types';
import EpisodesPage from './EpisodesPage';

const proposal = {
  title: '닫힌 문 너머',
  direction: '기록관이 사라진 동료의 흔적을 따라 왕궁에 들어간다.',
  conflicts: [],
};

const warningA: ContinuityIssue = {
  category: 'TIMELINE', severity: 'WARNING', excerpt: '해가 뜬 왕궁',
  explanation: '한밤중에 왕궁으로 향했는데 도착하자 아침입니다.',
  evidenceRefs: [], repairInstruction: '왕궁에 도착한 시각을 한밤중으로 맞추세요.',
};
const warningB: ContinuityIssue = {
  category: 'CHARACTER', severity: 'WARNING', excerpt: '동료의 왼손',
  explanation: '다친 오른손이 왼손으로 바뀌었습니다.',
  evidenceRefs: ['episode:previous'], repairInstruction: '다친 손을 오른손으로 통일하세요.',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/story/episodes']}>
        <Routes>
          <Route path="/projects/:projectId" element={<Outlet context={{ project: { genreTags: ['판타지'], logline: '기록관의 모험' } }} />}>
            <Route path="episodes" element={<EpisodesPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api.episodes, 'order').mockResolvedValue({ episodes: [], slots: [], revision: 'initial' });
  vi.spyOn(api.episodes, 'propose').mockResolvedValue(proposal);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openCreator() {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: '새 회차' }));
  return user;
}

describe('new episode flow', () => {
  it('repeatedly refines the latest edited title and direction, refreshes conflicts, and drafts from the final plan', async () => {
    vi.mocked(api.episodes.propose).mockResolvedValueOnce({ ...proposal, conflicts: ['처음 제안에서 확인할 충돌'] });
    const firstRefinement = {
      title: '문틈의 흔적', direction: '기록관이 동료가 남긴 표식을 살피며 왕궁에 잠입한다.', conflicts: ['개선 후 확인할 충돌'],
    };
    const finalRefinement = {
      title: '비밀의 표식', direction: `${firstRefinement.direction} 경비대와는 마주치지 않는다.`, conflicts: [],
    };
    const refine = vi.spyOn(api.episodes, 'refine')
      .mockResolvedValueOnce(firstRefinement)
      .mockResolvedValueOnce(finalRefinement);
    const generate = vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '표식을 따라간 최종 초안.', issues: [], blocked: false });
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));

    const title = await screen.findByLabelText('회차 제목');
    const direction = screen.getByLabelText('전개 방향');
    const instruction = screen.getByLabelText('개선 요청');
    await user.clear(title);
    await user.type(title, '  직접 다듬은 제목  ');
    await user.clear(direction);
    await user.type(direction, '  동료의 표식을 발견하고 왕궁에 잠입한다.\n');
    await user.type(instruction, '  잠입 장면만 더 긴장감 있게 해 줘  ');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(refine).toHaveBeenNthCalledWith(1, 'story', {
      title: '  직접 다듬은 제목  ', direction: '  동료의 표식을 발견하고 왕궁에 잠입한다.\n', instruction: '잠입 장면만 더 긴장감 있게 해 줘',
    }, expect.any(AbortSignal));
    expect(title).toHaveValue(firstRefinement.title);
    expect(direction).toHaveValue(firstRefinement.direction);
    expect(instruction).toHaveValue('');
    expect(screen.queryByText('처음 제안에서 확인할 충돌')).not.toBeInTheDocument();
    expect(screen.getByText('개선 후 확인할 충돌')).toBeVisible();

    await user.clear(title);
    await user.type(title, '표식의 비밀');
    await user.type(direction, ' 경비대와는 마주치지 않는다.');
    await user.type(instruction, '표식의 의미를 암시하도록 제목만 다듬어 줘');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(refine).toHaveBeenNthCalledWith(2, 'story', {
      title: '표식의 비밀', direction: `${firstRefinement.direction} 경비대와는 마주치지 않는다.`, instruction: '표식의 의미를 암시하도록 제목만 다듬어 줘',
    }, expect.any(AbortSignal));
    expect(title).toHaveValue(finalRefinement.title);
    expect(direction).toHaveValue(finalRefinement.direction);
    expect(instruction).toHaveValue('');
    expect(screen.queryByText('개선 후 확인할 충돌')).not.toBeInTheDocument();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'AI 초안 만들기' }));
    expect(await screen.findByLabelText('AI 초안 수정')).toHaveValue('표식을 따라간 최종 초안.');
    expect(generate).toHaveBeenCalledWith('story', {
      title: finalRefinement.title, direction: finalRefinement.direction,
    }, expect.any(Function), expect.any(AbortSignal));
    await user.click(screen.getByRole('button', { name: '초안 저장' }));
    expect(create).toHaveBeenCalledWith('story', {
      title: finalRefinement.title, direction: finalRefinement.direction, content: '표식을 따라간 최종 초안.', forceNeedsReview: false,
    }, expect.any(String));
  });

  it('requires a nonblank improvement request, title, and direction before refining', async () => {
    const refine = vi.spyOn(api.episodes, 'refine');
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));

    const instruction = await screen.findByLabelText('개선 요청');
    const button = screen.getByRole('button', { name: '개선' });
    expect(button).toBeDisabled();
    await user.type(instruction, '  \n  ');
    expect(button).toBeDisabled();
    await user.clear(instruction);
    await user.type(instruction, '결말에 여운을 더해 줘');
    expect(button).toBeEnabled();

    const title = screen.getByLabelText('회차 제목');
    await user.clear(title);
    expect(button).toBeDisabled();
    await user.type(title, '   ');
    expect(button).toBeDisabled();
    await user.clear(title);
    await user.type(title, proposal.title);
    const direction = screen.getByLabelText('전개 방향');
    await user.clear(direction);
    expect(button).toBeDisabled();
    await user.type(direction, ' \n ');
    expect(button).toBeDisabled();
    await user.clear(direction);
    await user.type(direction, proposal.direction);
    expect(button).toBeEnabled();
    expect(refine).not.toHaveBeenCalled();
  });

  it('keeps refinements, manual edits, and an unsent improvement request when returning through an unchanged initial request', async () => {
    const refined = { title: '개선한 제목', direction: '개선한 전개 방향', conflicts: ['개선한 전개에서 확인할 충돌'] };
    const refine = vi.spyOn(api.episodes, 'refine').mockResolvedValueOnce(refined);
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '왕궁 잠입');
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.type(await screen.findByLabelText('개선 요청'), '마지막 장면을 다듬어 줘');
    await user.click(screen.getByRole('button', { name: '개선' }));
    await user.type(screen.getByLabelText('회차 제목'), ' 직접 수정');
    await user.type(screen.getByLabelText('전개 방향'), ' 직접 추가한 장면.');
    await user.type(screen.getByLabelText('개선 요청'), '제목을 조금 더 짧게 다듬어 줘');
    await user.click(screen.getByRole('button', { name: '이전' }));

    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toHaveValue('왕궁 잠입');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(await screen.findByLabelText('회차 제목')).toHaveValue(`${refined.title} 직접 수정`);
    expect(screen.getByLabelText('전개 방향')).toHaveValue(`${refined.direction} 직접 추가한 장면.`);
    expect(screen.getByLabelText('개선 요청')).toHaveValue('제목을 조금 더 짧게 다듬어 줘');
    expect(screen.getByText('개선한 전개에서 확인할 충돌')).toBeVisible();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
    expect(refine).toHaveBeenCalledTimes(1);
  });

  it('preserves the current plan, conflicts, and improvement request after a failure and retries them', async () => {
    vi.mocked(api.episodes.propose).mockResolvedValueOnce({ ...proposal, conflicts: ['보존할 설정 충돌'] });
    const refine = vi.spyOn(api.episodes, 'refine')
      .mockRejectedValueOnce(new Error('개선을 완료하지 못했습니다.'))
      .mockResolvedValueOnce({ title: '다듬은 제목', direction: '다듬은 전개 방향', conflicts: [] });
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    const title = await screen.findByLabelText('회차 제목');
    const direction = screen.getByLabelText('전개 방향');
    const instruction = screen.getByLabelText('개선 요청');
    await user.type(title, ' 수정');
    await user.type(direction, ' 동료는 무사하다.');
    await user.type(instruction, '  동료의 흔적을 더 구체적으로 묘사해 줘  ');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(await screen.findByText('개선을 완료하지 못했습니다.')).toBeVisible();
    expect(title).toHaveValue(`${proposal.title} 수정`);
    expect(direction).toHaveValue(`${proposal.direction} 동료는 무사하다.`);
    expect(instruction).toHaveValue('  동료의 흔적을 더 구체적으로 묘사해 줘  ');
    expect(screen.getByText('보존할 설정 충돌')).toBeVisible();
    expect(title).toBeEnabled();
    expect(direction).toBeEnabled();
    expect(instruction).toBeEnabled();
    expect(screen.getByRole('button', { name: '개선' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '개선' }));
    expect(refine).toHaveBeenCalledTimes(2);
    expect(refine).toHaveBeenLastCalledWith('story', {
      title: `${proposal.title} 수정`, direction: `${proposal.direction} 동료는 무사하다.`, instruction: '동료의 흔적을 더 구체적으로 묘사해 줘',
    }, expect.any(AbortSignal));
    expect(title).toHaveValue('다듬은 제목');
    expect(direction).toHaveValue('다듬은 전개 방향');
    expect(instruction).toHaveValue('');
    expect(screen.queryByText('개선을 완료하지 못했습니다.')).not.toBeInTheDocument();
    expect(screen.queryByText('보존할 설정 충돌')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)('locks actions during refinement, aborts on close, and ignores a late %s in a new creator', async (completion) => {
    const newProposal = { title: '새로운 회차', direction: '새로운 이야기의 전개', conflicts: ['새로운 설정 충돌'] };
    vi.mocked(api.episodes.propose).mockResolvedValueOnce(proposal).mockResolvedValueOnce(newProposal);
    let finish!: (value: typeof proposal) => void;
    let fail!: (reason: Error) => void;
    const refine = vi.spyOn(api.episodes, 'refine').mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }));
    const generate = vi.spyOn(api.episodes, 'generate');
    const create = vi.spyOn(api.episodes, 'create');
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.type(await screen.findByLabelText('개선 요청'), '추격 장면만 짧게 해 줘');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(screen.getByRole('button', { name: '개선 중' })).toBeDisabled();
    expect(screen.getByLabelText('회차 제목')).toBeDisabled();
    expect(screen.getByLabelText('전개 방향')).toBeDisabled();
    expect(screen.getByLabelText('개선 요청')).toBeDisabled();
    expect(screen.getByRole('button', { name: '이전' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '빈 회차로 시작' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'AI 초안 만들기' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '개선 중' }));
    expect(refine).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    const signal = refine.mock.calls[0][2];
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(signal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByLabelText('회차 제목')).toHaveValue(newProposal.title);
    await user.type(screen.getByLabelText('개선 요청'), '새로운 회차에 대한 요청');
    await act(async () => {
      if (completion === 'success') finish({ title: '늦게 도착한 제목', direction: '늦게 도착한 방향', conflicts: [] });
      else fail(new Error('이전 개선 요청의 늦은 오류'));
    });

    expect(screen.getByLabelText('회차 제목')).toHaveValue(newProposal.title);
    expect(screen.getByLabelText('전개 방향')).toHaveValue(newProposal.direction);
    expect(screen.getByLabelText('개선 요청')).toHaveValue('새로운 회차에 대한 요청');
    expect(screen.getByText('새로운 설정 충돌')).toBeVisible();
    expect(screen.queryByText('이전 개선 요청의 늦은 오류')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '개선' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'AI 초안 만들기' })).toBeEnabled();
  });

  it('repairs individual warnings using the edited draft, refreshes the issues, and saves the final text', async () => {
    vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '수정 전 원고.', issues: [warningA, warningB], blocked: false });
    let finish!: (result: StreamResult) => void;
    const repair = vi.spyOn(api.episodes, 'repair').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));

    const textarea = screen.getByLabelText('AI 초안 수정') as HTMLTextAreaElement;
    const issueButtons = screen.getAllByRole('button', { name: /^자동 수정:/ });
    expect(issueButtons).toHaveLength(2);
    issueButtons.forEach((button) => expect(button).toHaveTextContent('자동 수정'));
    await user.clear(textarea);
    await user.type(textarea, '사용자가 다듬은 원고.');
    await user.click(screen.getByRole('button', { name: `자동 수정: ${warningB.explanation}` }));

    expect(repair).toHaveBeenCalledWith('story', {
      title: proposal.title, direction: proposal.direction, content: '사용자가 다듬은 원고.', issue: warningB,
    }, expect.any(Function), expect.any(AbortSignal));
    expect(textarea).toHaveValue('사용자가 다듬은 원고.');
    expect(textarea.readOnly).toBe(true);
    expect(screen.getByText(warningA.explanation)).toBeVisible();
    expect(screen.getByText(warningB.explanation)).toBeVisible();
    expect(screen.getByRole('button', { name: `자동 수정: ${warningA.explanation}` })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '초안 저장' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다시 생성' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '수정 중단' })).toBeEnabled();

    const refreshedIssue: ContinuityIssue = { ...warningA, excerpt: '밝아진 왕궁', explanation: '왕궁 안의 밝기를 한밤중에 맞춰 주세요.' };
    await act(async () => finish({ content: '오른손으로 바로잡은 원고.', issues: [refreshedIssue], blocked: false }));
    expect(textarea).toHaveValue('오른손으로 바로잡은 원고.');
    expect(textarea.readOnly).toBe(false);
    expect(screen.queryByText(warningA.explanation)).not.toBeInTheDocument();
    expect(screen.queryByText(warningB.explanation)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^자동 수정:/ })).toHaveLength(1);

    await user.type(textarea, ' 다음 장면도 직접 고쳤다.');
    repair.mockResolvedValueOnce({ content: '두 주의를 고친 최종 원고.', issues: [], blocked: false });
    await user.click(screen.getByRole('button', { name: `자동 수정: ${refreshedIssue.explanation}` }));
    expect(repair).toHaveBeenLastCalledWith('story', {
      title: proposal.title, direction: proposal.direction,
      content: '오른손으로 바로잡은 원고. 다음 장면도 직접 고쳤다.', issue: refreshedIssue,
    }, expect.any(Function), expect.any(AbortSignal));
    expect(textarea).toHaveValue('두 주의를 고친 최종 원고.');
    expect(screen.queryByRole('button', { name: /^자동 수정:/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '초안 저장' }));
    expect(create).toHaveBeenCalledWith('story', {
      title: proposal.title, direction: proposal.direction, content: '두 주의를 고친 최종 원고.', forceNeedsReview: false,
    }, expect.any(String));
  });

  it.each(['error', 'cancel'] as const)('preserves the reviewed draft and warnings after a selective repair %s and allows retry', async (failure) => {
    vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '보존할 검토 완료 원고.', issues: [warningA, warningB], blocked: false });
    const repair = vi.spyOn(api.episodes, 'repair');
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { stream = controller; },
    }))));
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));
    await user.click(screen.getByRole('button', { name: `자동 수정: ${warningB.explanation}` }));
    const signal = repair.mock.calls[0][3];
    const send = async (event: unknown) => act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    });
    await send({ type: 'stage', stage: 'REPAIRING' });
    await send({ type: 'reset' });
    await send({ type: 'delta', text: '아직 완성되지 않은 수정' });
    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('보존할 검토 완료 원고.');
    if (failure === 'error') {
      await send({ type: 'error', code: 'FAILED', message: '선택한 문제를 수정하지 못했습니다.' });
      expect(await screen.findByText('선택한 문제를 수정하지 못했습니다.')).toBeVisible();
    } else {
      await user.click(screen.getByRole('button', { name: '수정 중단' }));
      expect(signal?.aborted).toBe(true);
    }

    expect(await screen.findByRole('button', { name: '초안 저장' })).toBeEnabled();
    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('보존할 검토 완료 원고.');
    expect((screen.getByLabelText('AI 초안 수정') as HTMLTextAreaElement).readOnly).toBe(false);
    expect(screen.getByText(warningA.explanation)).toBeVisible();
    expect(screen.getByText(warningB.explanation)).toBeVisible();
    expect(screen.getByRole('button', { name: `자동 수정: ${warningA.explanation}` })).toBeEnabled();
    repair.mockResolvedValueOnce({ content: '재시도에서 수정된 원고.', issues: [warningA], blocked: false });
    await user.click(screen.getByRole('button', { name: `자동 수정: ${warningB.explanation}` }));
    expect(repair).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('재시도에서 수정된 원고.');
    expect(screen.queryByText(warningB.explanation)).not.toBeInTheDocument();
  });

  it('aborts a selective repair when closed and ignores its late result after creating another draft', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(api.episodes, 'generate')
      .mockResolvedValueOnce({ content: '첫 번째 초안.', issues: [warningA], blocked: false })
      .mockResolvedValueOnce({ content: '새로 연 초안.', issues: [warningB], blocked: false });
    let finish!: (result: StreamResult) => void;
    const repair = vi.spyOn(api.episodes, 'repair').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));
    await user.click(screen.getByRole('button', { name: `자동 수정: ${warningA.explanation}` }));
    const signal = repair.mock.calls[0][3];
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(signal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));
    await act(async () => {
      repair.mock.calls[0][2]({ type: 'done', content: '늦게 도착한 이전 수정.', issues: [], blocked: false }, '늦게 도착한 이전 수정.');
      finish({ content: '늦게 도착한 이전 수정.', issues: [], blocked: false });
    });

    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('새로 연 초안.');
    expect(screen.getByRole('button', { name: `자동 수정: ${warningB.explanation}` })).toBeEnabled();
    expect(screen.getByRole('button', { name: '초안 저장' })).toBeEnabled();
  });

  it('keeps the same readable textarea and scroll position through writing, checking and completion', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { stream = controller; },
    }))));
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));
    const textarea = screen.getByLabelText('AI 초안 수정') as HTMLTextAreaElement;
    const draft = '문을 열자 빛이 쏟아졌다.\n\n'.repeat(500);
    const send = async (event: unknown) => act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    });
    await send({ type: 'stage', stage: 'WRITING' });
    await send({ type: 'delta', text: draft });
    textarea.scrollTop = 640;
    textarea.dispatchEvent(new Event('scroll'));
    await send({ type: 'stage', stage: 'CHECKING' });

    expect(screen.getByLabelText('AI 초안 수정')).toBe(textarea);
    expect(textarea).toHaveValue(draft);
    expect(textarea.readOnly).toBe(true);
    expect(textarea).toBeEnabled();
    expect(textarea.scrollTop).toBe(640);
    const status = screen.getByText('일관성을 확인하는 중');
    expect(status.closest('.sheet-body')).toBeNull();
    expect(status).toBeVisible();

    const repaired = draft.replaceAll('빛이', '비가');
    await send({ type: 'done', content: repaired, issues: [], blocked: false });
    expect(screen.getByLabelText('AI 초안 수정')).toBe(textarea);
    expect(textarea).toHaveValue(repaired);
    expect(textarea.readOnly).toBe(false);
    expect(textarea.scrollTop).toBe(640);
    expect(screen.getByRole('button', { name: '초안 저장' })).toBeEnabled();
  });

  it.each(['error', 'empty', 'eof', 'cancel'] as const)('preserves the draft when repair ends with %s', async (failure) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { stream = controller; },
    }))));
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));
    const send = async (event: unknown) => act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    });
    await send({ type: 'delta', text: '보존해야 할 원고.' });
    await send({ type: 'stage', stage: 'CHECKING' });
    await send({ type: 'stage', stage: 'REPAIRING' });
    await send({ type: 'reset' });
    await send({ type: 'delta', text: '아직 완성되지 않은 보정' });
    expect(screen.getByText('충돌을 바로잡는 중')).toBeVisible();
    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('보존해야 할 원고.');

    if (failure === 'error') await send({ type: 'error', code: 'FAILED', message: '보정 오류' });
    if (failure === 'empty') await send({ type: 'done', content: ' ', issues: [], blocked: false });
    if (failure === 'eof') await act(async () => stream.close());
    if (failure === 'cancel') await user.click(screen.getByRole('button', { name: '생성 중단' }));

    expect(await screen.findByRole('button', { name: '검토 필요로 저장' })).toBeEnabled();
    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('보존해야 할 원고.');
    expect((screen.getByLabelText('AI 초안 수정') as HTMLTextAreaElement).readOnly).toBe(false);
    await user.click(screen.getByRole('button', { name: '검토 필요로 저장' }));
    expect(create).toHaveBeenCalledWith('story', expect.objectContaining({ content: '보존해야 할 원고.', forceNeedsReview: true }), expect.any(String));
  });

  it('starts with one optional request and generates the title and direction on next, even when empty', async () => {
    const generate = vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '완성된 첫 문장.', issues: [], blocked: false });
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getAllByRole('textbox')).toHaveLength(1);
    expect(dialog.getByLabelText(/이번 회차에 원하는 것/)).not.toBeRequired();
    expect(dialog.getByRole('button', { name: '다음' })).toBeEnabled();
    expect(dialog.queryByRole('button', { name: /제안/ })).not.toBeInTheDocument();
    expect(dialog.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();

    await user.click(dialog.getByRole('button', { name: '다음' }));

    expect(api.episodes.propose).toHaveBeenCalledWith('story', undefined, expect.any(AbortSignal));
    expect(await dialog.findByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(dialog.getByLabelText('전개 방향')).toHaveValue(proposal.direction);
    expect(dialog.queryByLabelText(/이번 회차에 원하는 것/)).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    await user.click(dialog.getByRole('button', { name: 'AI 초안 만들기' }));
    expect(await dialog.findByLabelText('AI 초안 수정')).toHaveValue('완성된 첫 문장.');
    expect(generate).toHaveBeenCalledWith('story', { title: proposal.title, direction: proposal.direction }, expect.any(Function), expect.any(AbortSignal));
    await user.click(dialog.getByRole('button', { name: '초안 저장' }));
    expect(create).toHaveBeenCalledWith('story', {
      title: proposal.title, direction: proposal.direction, content: '완성된 첫 문장.', forceNeedsReview: false,
    }, expect.any(String));
  });

  it('sends only the user request and lets the generated plan be edited before starting an empty episode', async () => {
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '  능력을 들키는 장면\n동료의 반응도 보여 줘  ');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(api.episodes.propose).toHaveBeenCalledWith('story', '능력을 들키는 장면\n동료의 반응도 보여 줘', expect.any(AbortSignal));
    const title = await screen.findByLabelText('회차 제목');
    await user.clear(title);
    await user.type(title, '드러난 비밀');
    await user.click(screen.getByRole('button', { name: '빈 회차로 시작' }));
    expect(create).toHaveBeenCalledWith('story', {
      title: '드러난 비밀', direction: proposal.direction, content: '', forceNeedsReview: false,
    }, expect.any(String));
  });

  it('keeps the request after a planning failure and retries from next', async () => {
    vi.mocked(api.episodes.propose).mockRejectedValueOnce(new Error('일시적인 생성 오류'));
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '동료와 화해');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(await screen.findByText('일시적인 생성 오류')).toBeInTheDocument();
    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toHaveValue('동료와 화해');
    expect(screen.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(api.episodes.propose).toHaveBeenCalledTimes(2);
  });

  it('disables duplicate next requests and discards late results after closing', async () => {
    let finish!: (value: typeof proposal) => void;
    vi.mocked(api.episodes.propose).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(screen.getByRole('button', { name: '만드는 중' })).toBeDisabled();
    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toBeDisabled();
    const signal = vi.mocked(api.episodes.propose).mock.calls[0][2];
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(signal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    await act(async () => finish(proposal));

    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toHaveValue('');
    expect(screen.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다음' })).toBeEnabled();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
  });
});

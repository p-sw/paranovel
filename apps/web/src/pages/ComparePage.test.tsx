import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../api/client';
import type { ImprovementCandidate } from '../types';
import ComparePage from './ComparePage';

const draft = { content: '그는 놀랐다.', blocked: false, issues: [] };
const candidate: ImprovementCandidate & { source: 'COMPARISON' } = {
  title: '감정을 행동으로 보여 주기',
  rule: '감정은 구체적인 신체 반응으로 보여 준다.',
  rationale: '추상적인 감정 서술이 구체적인 행동으로 바뀌었다.',
  category: '감정 표현',
  tags: ['묘사'],
  beforeExample: draft.content,
  afterExample: '그의 손끝이 굳었다.',
  confidence: 0.9,
  duplicateOfId: null,
  conflictsWithIds: [],
  source: 'COMPARISON',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><ComparePage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

function enterManuscripts(original = '수정 전 원고', revised = '수정 후 원고') {
  fireEvent.change(screen.getByRole('textbox', { name: '전 원고' }), { target: { value: original } });
  fireEvent.change(screen.getByRole('textbox', { name: '후 원고' }), { target: { value: revised } });
}

async function generateDraft() {
  fireEvent.change(screen.getByLabelText('공통 방향·브리프'), { target: { value: '  비 오는 성벽에서의 대치  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'AI 초안 생성' }));
  await screen.findByText('전 원고 · AI 초안');
}

beforeEach(() => {
  vi.spyOn(api.projects, 'list').mockResolvedValue([]);
  vi.spyOn(api.comparisons, 'generate').mockImplementation(async (_input, onEvent) => {
    onEvent({ type: 'delta', text: draft.content }, draft.content);
    onEvent({ type: 'done', ...draft }, draft.content);
    return draft;
  });
  vi.spyOn(api.improvements, 'candidates').mockResolvedValue({ candidates: [candidate] });
  vi.spyOn(api.improvements, 'accept').mockResolvedValue({ improvements: [] });
});

afterEach(() => vi.restoreAllMocks());

describe('two manuscript comparison flows', () => {
  it('takes only a brief first, shows the AI draft, then compares the user revision and saves reviewed rules', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('textbox', { name: '후 원고' })).not.toBeInTheDocument();
    await generateDraft();

    expect(api.comparisons.generate).toHaveBeenCalledWith(
      { brief: '비 오는 성벽에서의 대치', targetChars: 3000 }, expect.any(Function), expect.any(AbortSignal),
    );
    expect(screen.getByText(draft.content)).toBeInTheDocument();
    expect(screen.queryByLabelText('전 원고 · AI 초안')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '후 원고' })).toHaveValue('');
    expect(screen.getByRole('tab', { name: '전 원고 · AI' })).toHaveAttribute('data-state', 'active');
    expect(api.improvements.candidates).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));
    expect(screen.getByText('전 원고와 후 원고를 모두 입력해 주세요.')).toBeInTheDocument();
    expect(api.improvements.candidates).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: '후 원고' }));
    await user.type(screen.getByRole('textbox', { name: '후 원고' }), '그의 손끝이 굳었다.');
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));

    expect(await screen.findByLabelText('항상 적용할 규칙')).toHaveValue(candidate.rule);
    expect(api.improvements.candidates).toHaveBeenCalledWith({
      source: 'COMPARISON', original: draft.content, revised: '그의 손끝이 굳었다.',
    });
    expect(screen.getByRole('tab', { name: '개선점' })).toHaveAttribute('data-state', 'active');
    expect(api.improvements.accept).not.toHaveBeenCalled();

    const updatedRule = '감정을 설명하기 전에 인물의 손짓과 표정을 보여 준다.';
    await user.clear(screen.getByLabelText('항상 적용할 규칙'));
    await user.type(screen.getByLabelText('항상 적용할 규칙'), updatedRule);
    await user.click(screen.getByRole('button', { name: '선택한 개선점 저장' }));

    expect(await screen.findByText('개선점을 저장했어요')).toBeInTheDocument();
    expect(api.improvements.accept).toHaveBeenCalledWith({ candidates: [{ ...candidate, rule: updatedRule }] }, expect.any(String));
  });

  it('accepts two user textareas and extracts after-versus-before improvements without generating a draft', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^원고만 입력/ }));

    expect(screen.queryByLabelText('공통 방향·브리프')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('AI 초안 목표 글자 수')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox').map((element) => element.tagName)).toEqual(['TEXTAREA', 'TEXTAREA']);
    enterManuscripts('그는 놀랐다.\n문이 열렸다.', '그의 손끝이 굳었다.\n문이 열렸다.');
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));

    expect(await screen.findByLabelText('항상 적용할 규칙')).toBeInTheDocument();
    expect(api.comparisons.generate).not.toHaveBeenCalled();
    expect(api.improvements.candidates).toHaveBeenCalledWith({
      source: 'COMPARISON', original: '그는 놀랐다.\n문이 열렸다.', revised: '그의 손끝이 굳었다.\n문이 열렸다.',
    });

    await user.click(screen.getByRole('button', { name: '비교로 돌아가기' }));
    expect(screen.getByRole('textbox', { name: '전 원고' })).toHaveValue('그는 놀랐다.\n문이 열렸다.');
    expect(screen.getByRole('textbox', { name: '후 원고' })).toHaveValue('그의 손끝이 굳었다.\n문이 열렸다.');
    fireEvent.change(screen.getByRole('textbox', { name: '후 원고' }), { target: { value: '그는 숨을 삼켰다.' } });
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));
    await screen.findByLabelText('항상 적용할 규칙');
    expect(api.improvements.candidates).toHaveBeenLastCalledWith({
      source: 'COMPARISON', original: '그는 놀랐다.\n문이 열렸다.', revised: '그는 숨을 삼켰다.',
    });
  });

  it('keeps the manuscripts for each mode separate when switching back and forth', async () => {
    const user = userEvent.setup();
    renderPage();
    await generateDraft();
    fireEvent.change(screen.getByRole('textbox', { name: '후 원고' }), { target: { value: 'AI 초안의 수정본' } });

    await user.click(screen.getByRole('button', { name: /^원고만 입력/ }));
    expect(screen.getByRole('textbox', { name: '전 원고' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '후 원고' })).toHaveValue('');
    enterManuscripts('직접 쓴 전 원고', '직접 쓴 후 원고');

    await user.click(screen.getByRole('button', { name: /^공통 방향·브리프/ }));
    expect(screen.getByText(draft.content)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '후 원고' })).toHaveValue('AI 초안의 수정본');
    await user.click(screen.getByRole('button', { name: '브리프 수정' }));
    expect(screen.getByLabelText('공통 방향·브리프')).toHaveValue('  비 오는 성벽에서의 대치  ');
    await user.click(screen.getByRole('button', { name: '기존 초안 비교로 돌아가기' }));
    expect(screen.getByRole('textbox', { name: '후 원고' })).toHaveValue('AI 초안의 수정본');

    await user.click(screen.getByRole('button', { name: /^원고만 입력/ }));
    expect(screen.getByRole('textbox', { name: '전 원고' })).toHaveValue('직접 쓴 전 원고');
    expect(screen.getByRole('textbox', { name: '후 원고' })).toHaveValue('직접 쓴 후 원고');
    expect(api.comparisons.generate).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or identical manuscripts before requesting analysis', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^원고만 입력/ }));

    enterManuscripts('', '후 원고만 입력');
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));
    expect(screen.getByText('전 원고와 후 원고를 모두 입력해 주세요.')).toBeInTheDocument();
    enterManuscripts('전 원고만 입력', '   ');
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));
    expect(screen.getByText('전 원고와 후 원고를 모두 입력해 주세요.')).toBeInTheDocument();
    enterManuscripts('같은 원고', '  같은 원고  ');
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));
    expect(screen.getByText('전 원고와 후 원고가 같아요. 후 원고를 수정한 뒤 비교해 주세요.')).toBeInTheDocument();
    expect(api.improvements.candidates).not.toHaveBeenCalled();
  });

  it('preserves both manuscripts after an analysis error and allows a retry with no candidates', async () => {
    vi.mocked(api.improvements.candidates)
      .mockRejectedValueOnce(new Error('분석을 다시 시도해 주세요.'))
      .mockResolvedValueOnce({ candidates: [] });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^원고만 입력/ }));
    enterManuscripts();
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));

    expect(await screen.findByText('분석을 다시 시도해 주세요.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '전 원고' })).toHaveValue('수정 전 원고');
    expect(screen.getByRole('textbox', { name: '후 원고' })).toHaveValue('수정 후 원고');
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));

    expect(await screen.findByText('두 원고에서 반복 적용할 만큼 뚜렷한 차이를 찾지 못했어요.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '선택한 개선점 저장' })).not.toBeInTheDocument();
    expect(api.improvements.candidates).toHaveBeenCalledTimes(2);
  });

  it('locks manuscript inputs and mode changes while analysis is pending', async () => {
    let finish!: (value: { candidates: ImprovementCandidate[] }) => void;
    vi.mocked(api.improvements.candidates).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^원고만 입력/ }));
    enterManuscripts();
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));

    expect(screen.getByRole('textbox', { name: '전 원고' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '후 원고' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^공통 방향·브리프/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '개선점 찾기' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '개선점 찾기' }));
    expect(api.improvements.candidates).toHaveBeenCalledTimes(1);
    await act(async () => finish({ candidates: [] }));
    expect(screen.getByRole('button', { name: '비교로 돌아가기' })).toBeEnabled();
  });

  it('validates the brief and target length, and retains the brief after a generation error', async () => {
    vi.mocked(api.comparisons.generate).mockRejectedValueOnce(new Error('초안 생성 실패'));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'AI 초안 생성' }));
    expect(screen.getByText('공통 방향·브리프를 입력해 주세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('공통 방향·브리프'), { target: { value: '비 오는 성벽' } });
    fireEvent.change(screen.getByLabelText('AI 초안 목표 글자 수'), { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: 'AI 초안 생성' }));
    expect(screen.getByText('목표 글자 수는 300~10,000 사이의 정수로 입력해 주세요.')).toBeInTheDocument();
    expect(api.comparisons.generate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('AI 초안 목표 글자 수'), { target: { value: '3000' } });
    await user.click(screen.getByRole('button', { name: 'AI 초안 생성' }));
    expect(await screen.findByText('초안 생성 실패')).toBeInTheDocument();
    expect(screen.getByLabelText('공통 방향·브리프')).toHaveValue('비 오는 성벽');
    await user.click(screen.getByRole('button', { name: 'AI 초안 생성' }));
    expect(await screen.findByRole('textbox', { name: '후 원고' })).toHaveValue('');
  });

  it('discards partial and late generation results after cancellation', async () => {
    let finish!: (value: typeof draft) => void;
    vi.mocked(api.comparisons.generate).mockImplementationOnce((_input, onEvent) => {
      onEvent({ type: 'delta', text: '생성 중인 원고' }, '생성 중인 원고');
      return new Promise((resolve) => { finish = resolve; });
    });
    const user = userEvent.setup();
    renderPage();
    fireEvent.change(screen.getByLabelText('공통 방향·브리프'), { target: { value: '비 오는 성벽' } });
    await user.click(screen.getByRole('button', { name: 'AI 초안 생성' }));
    expect(screen.getByText('생성 중인 원고')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^원고만 입력/ })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: '후 원고' })).not.toBeInTheDocument();
    const signal = vi.mocked(api.comparisons.generate).mock.calls[0][2];
    await user.click(screen.getByRole('button', { name: '중단' }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByLabelText('공통 방향·브리프')).toHaveValue('비 오는 성벽');

    await user.click(screen.getByRole('button', { name: /^원고만 입력/ }));
    enterManuscripts();
    await act(async () => finish(draft));
    expect(screen.getByRole('textbox', { name: '전 원고' })).toHaveValue('수정 전 원고');
    expect(screen.queryByText('전 원고 · AI 초안')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^공통 방향·브리프/ }));
    expect(screen.queryByRole('button', { name: '기존 초안 비교로 돌아가기' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'AI 초안 생성' }));
    expect(await screen.findByRole('textbox', { name: '후 원고' })).toHaveValue('');
  });
});

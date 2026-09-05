import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { ProjectSessionResult, SetupAnswerRecord, SetupQuestion } from '../types';
import ProjectWizardPage from './ProjectWizardPage';

const title: SetupQuestion = { id: 'title', field: 'title', prompt: '작품 제목은?', inputType: 'text', options: [], required: true };
const tone: SetupQuestion = { id: 'tone', field: 'tone', prompt: '어떤 분위기인가요?', inputType: 'single', options: ['밝음', '어두움'], required: false };
const traits: SetupQuestion = { id: 'traits', field: 'traits', prompt: '주인공의 특성은?', inputType: 'multi', options: ['용기', '지혜'], required: false };
const titleRecord: SetupAnswerRecord = { question: title, answer: '달 없는 밤', skipped: false };
const toneRecord: SetupAnswerRecord = { question: tone, answer: '밝음', skipped: false };

function session(question: SetupQuestion, history: SetupAnswerRecord[] = []): ProjectSessionResult {
  return { session: { id: 'session-1' }, step: { type: 'question', question }, history, stateToken: `state-${history.length}` };
}

function readySession(history: SetupAnswerRecord[] = [titleRecord, toneRecord]): ProjectSessionResult {
  return {
    session: { id: 'session-1' }, history, stateToken: 'ready-state',
    step: { type: 'ready', blueprint: {
      title: '달 없는 밤', logline: '잃어버린 달을 찾는다.', genreTags: ['판타지'], details: '', defaultTargetChars: 5000, canon: [],
      arc: { title: '달의 흔적', startEpisode: 1, endEpisode: 5, goal: '달 찾기', conflict: '추격자', reversalPlan: [] },
    } },
  };
}

async function renderSession(result: ProjectSessionResult) {
  sessionStorage.setItem('paranovel.project-session', JSON.stringify(result));
  const get = vi.spyOn(api.sessions, 'get').mockResolvedValue(result);
  const respond = vi.spyOn(api.sessions, 'respond').mockResolvedValue(readySession());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><ProjectWizardPage /></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('heading', { name: result.step.type === 'question' ? result.step.question.prompt : '이 세계로 시작할까요?' });
  return { ...view, get, respond, user: userEvent.setup() };
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('project interview input and navigation', () => {
  it('enables the Other textarea only for Other and omits it when submitting an AI choice', async () => {
    const { user, respond } = await renderSession(session(tone, [titleRecord]));
    const textarea = screen.getByLabelText('기타 답변');
    expect(textarea).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: '기타 (직접 입력)' }));
    expect(textarea).toBeEnabled();
    expect(screen.getByRole('button', { name: '다음 질문' })).toBeDisabled();
    await user.type(textarea, '따뜻한 분위기');
    await user.click(screen.getByRole('radio', { name: '밝음' }));
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveValue('');
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    expect(respond).toHaveBeenCalledWith('session-1', { questionId: 'tone', answer: '밝음', position: 1, expectedState: 'state-1' });
  });

  it('submits only trimmed Other text and restores the input mode from history', async () => {
    const otherRecord: SetupAnswerRecord = { question: tone, answer: '쓸쓸하지만 따뜻함', otherAnswer: '쓸쓸하지만 따뜻함', skipped: false };
    const { user, respond } = await renderSession(session(traits, [titleRecord, otherRecord]));
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    expect(screen.getByRole('radio', { name: '기타 (직접 입력)' })).toBeChecked();
    expect(screen.getByLabelText('기타 답변')).toHaveValue('쓸쓸하지만 따뜻함');
    await user.clear(screen.getByLabelText('기타 답변'));
    await user.type(screen.getByLabelText('기타 답변'), '  밝고 따뜻함  ');
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    expect(respond).toHaveBeenCalledWith('session-1', { questionId: 'tone', otherAnswer: '밝고 따뜻함', position: 1, expectedState: 'state-2' });
  });

  it('makes Other mutually exclusive with all multiple-choice selections', async () => {
    const { user, respond } = await renderSession(session(traits, [titleRecord, toneRecord]));
    await user.click(screen.getByRole('checkbox', { name: '용기' }));
    await user.click(screen.getByRole('checkbox', { name: '지혜' }));
    await user.click(screen.getByRole('checkbox', { name: '기타 (직접 입력)' }));
    expect(screen.getByRole('checkbox', { name: '용기' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '지혜' })).not.toBeChecked();
    await user.type(screen.getByLabelText('기타 답변'), '끈기');
    await user.click(screen.getByRole('checkbox', { name: '지혜' }));
    expect(screen.getByRole('checkbox', { name: '기타 (직접 입력)' })).not.toBeChecked();
    expect(screen.getByLabelText('기타 답변')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    expect(respond).toHaveBeenCalledWith('session-1', { questionId: 'traits', answer: ['지혜'], position: 2, expectedState: 'state-2' });
  });

  it('preserves pending input and later answers while browsing previous questions unchanged', async () => {
    const { user, respond } = await renderSession(session(traits, [titleRecord, toneRecord]));
    await user.click(screen.getByRole('checkbox', { name: '용기' }));
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    expect(screen.getByRole('radio', { name: '밝음' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    expect(screen.getByRole('button', { name: '이전 질문' })).toBeDisabled();
    expect(screen.getByLabelText('답변')).toHaveValue('달 없는 밤');
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    expect(screen.getByRole('heading', { name: traits.prompt })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '용기' })).toBeChecked();
    expect(respond).not.toHaveBeenCalled();
  });

  it('submits a changed earlier answer with its position and displays the regenerated next question', async () => {
    const { user, respond } = await renderSession(session(traits, [titleRecord, toneRecord]));
    respond.mockResolvedValue(session(tone, [{ ...titleRecord, answer: '새 제목' }]));
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    await user.clear(screen.getByLabelText('답변'));
    await user.type(screen.getByLabelText('답변'), '새 제목');
    expect(respond).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    expect(respond).toHaveBeenCalledWith('session-1', { questionId: 'title', answer: '새 제목', position: 0, expectedState: 'state-2' });
    await screen.findByRole('heading', { name: tone.prompt });
    expect(screen.getByRole('radio', { name: '밝음' })).not.toBeChecked();
  });

  it('can leave final review and return without losing edited blueprint fields', async () => {
    const { user, respond } = await renderSession(readySession());
    await user.clear(screen.getByLabelText('소설 제목'));
    await user.type(screen.getByLabelText('소설 제목'), '확인 화면에서 수정한 제목');
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    expect(screen.getByRole('radio', { name: '밝음' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: '설정 확인' }));
    expect(screen.getByLabelText('소설 제목')).toHaveValue('확인 화면에서 수정한 제목');
    expect(respond).not.toHaveBeenCalled();
  });

  it('can traverse a skipped historical answer without creating a new answer', async () => {
    const { user, respond } = await renderSession(readySession([titleRecord, { question: tone, answer: null, skipped: true }]));
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    expect(screen.getByRole('button', { name: '설정 확인' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '설정 확인' }));
    expect(screen.getByRole('heading', { name: '이 세계로 시작할까요?' })).toBeVisible();
    expect(respond).not.toHaveBeenCalled();
  });

  it('recovers server history after stale state and prevents navigation during a submitted turn', async () => {
    const { user, respond, get } = await renderSession(session(tone, [titleRecord]));
    let rejectTurn!: (error: Error) => void;
    respond.mockImplementation(() => new Promise((_, reject) => { rejectTurn = reject; }));
    get.mockResolvedValue(session(traits, [titleRecord, toneRecord]));
    await user.click(screen.getByRole('radio', { name: '밝음' }));
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    expect(screen.getByRole('button', { name: '이전 질문' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '밝음' })).toBeDisabled();
    rejectTurn(new ApiError('stale', 409));
    await screen.findByRole('heading', { name: traits.prompt });
    expect(screen.getByText('서버에 저장된 최신 인터뷰 단계로 복구했습니다. 내용을 확인하고 계속해 주세요.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '이전 질문' }));
    expect(screen.getByRole('radio', { name: '밝음' })).toBeChecked();
  });

  it('restores a legacy session that did not store history or a state token', async () => {
    const legacy = { session: { id: 'session-1' }, step: { type: 'question' as const, question: title } };
    const { user, respond } = await renderSession(legacy);
    expect(screen.getByRole('button', { name: '이전 질문' })).toBeDisabled();
    expect(screen.queryByLabelText('기타 답변')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('답변'), '제목');
    await user.click(screen.getByRole('button', { name: '다음 질문' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith('session-1', { questionId: 'title', answer: '제목' }));
  });
});

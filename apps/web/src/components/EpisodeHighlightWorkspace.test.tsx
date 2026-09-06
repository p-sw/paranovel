import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HighlightImage, HighlightState } from '@paranovel/contracts';
import { api } from '../api/client';
import type { Episode } from '../types';
import EpisodeHighlightWorkspace, { EpisodeReadingPreview } from './EpisodeHighlightWorkspace';

const original = '  첫 문단.\r\n\r\n문이 열렸다. 🌙\n\n 마지막 문단.\n';
const image: HighlightImage = {
  id: 'picture', url: '/api/picture/image', altText: '달빛 아래 열린 문',
  generatedSourceRevision: 3, generatedSourceContent: original, anchorSourceContent: original,
  anchorText: '문이 열렸다. 🌙', anchorOffset: original.indexOf('\n\n 마지막'), createdAt: '2026-09-01T00:00:00Z',
};
const empty: HighlightState = { configured: true, image: null, generation: null };
const ready: HighlightState = { ...empty, image };
const episode = { id: 'episode', projectId: 'project', title: '달빛', direction: '', content: original, revision: 3 } as Episode;

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function workspace(options: { state?: HighlightState; content?: string; captureSource?: () => Promise<Episode> } = {}) {
  const source = options.captureSource ?? vi.fn().mockResolvedValue(episode);
  vi.spyOn(api.highlights, 'get').mockResolvedValue(options.state ?? empty);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onReadingChange = vi.fn();
  const element = (content = options.content ?? original) => <QueryClientProvider client={client}>
    <EpisodeHighlightWorkspace projectId="project" episodeId="episode" content={content} reading onReadingChange={onReadingChange} captureSource={source} disabled={false}>
      {(preview) => preview}
    </EpisodeHighlightWorkspace>
  </QueryClientProvider>;
  const result = render(element());
  return { ...result, source, client, onReadingChange, changeContent: (content: string) => result.rerender(element(content)) };
}

describe('illustrated episode preview', () => {
  it('preserves every whitespace character and inserts the image after its exact UTF-16 paragraph', () => {
    render(<EpisodeReadingPreview content={original} image={image} />);
    const prose = screen.getByLabelText('회차 읽기 미리보기').querySelector('.episode-reading-prose')!;
    expect(prose.textContent).toBe(original);
    expect(prose.childNodes[0].textContent).toBe(original.slice(0, image.anchorOffset));
    expect(prose.childNodes[1]).toBe(screen.getByAltText(image.altText).closest('figure'));
    expect(prose.childNodes[2].textContent).toBe(original.slice(image.anchorOffset));
  });

  it('retains an unplaced image when an edited manuscript has duplicate matching paragraphs', () => {
    const content = `문이 열렸다. 🌙\n${original}`;
    render(<EpisodeReadingPreview content={content} image={image} />);
    const prose = screen.getByLabelText('회차 읽기 미리보기').querySelector('.episode-reading-prose')!;
    expect(prose.textContent).toBe(content);
    expect(prose.querySelector('img')).toBeNull();
    expect(within(screen.getByLabelText('위치를 확인할 삽화')).getByAltText(image.altText)).toBeInTheDocument();
  });
});

describe('manual highlight lifecycle', () => {
  it('keeps newer local prose when a picture finishes for an earlier snapshot', async () => {
    let complete!: (value: HighlightState) => void;
    const generate = vi.spyOn(api.highlights, 'generate').mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const view = workspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '하이라이트 삽화 생성' }));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate).toHaveBeenCalledWith('project', 'episode', 3, expect.any(String));
    const edited = `새로운 시작.\n${original}`;
    view.changeContent(edited);
    await act(async () => complete({ ...ready, generation: {
      id: 'job', idempotencyKey: generate.mock.calls[0][3], expectedRevision: 3,
      status: 'SUCCEEDED', error: null, retryableDownload: false,
    } }));
    expect(await screen.findByText('본문 변경됨')).toBeInTheDocument();
    expect(screen.getByLabelText('회차 읽기 미리보기').querySelector('.episode-reading-prose')?.textContent).toBe(edited);
    expect(screen.getByAltText(image.altText)).toBeInTheDocument();
    expect(view.onReadingChange).not.toHaveBeenCalled();
  });

  it('opens the reading preview after generation when the source manuscript is still current', async () => {
    vi.spyOn(api.highlights, 'generate').mockImplementation(async (_projectId, _episodeId, expectedRevision, idempotencyKey) => ({
      ...ready, generation: { id: 'job', status: 'SUCCEEDED', error: null, retryableDownload: false, expectedRevision, idempotencyKey },
    }));
    const view = workspace();
    await userEvent.setup().click(await screen.findByRole('button', { name: '하이라이트 삽화 생성' }));
    await waitFor(() => expect(view.onReadingChange).toHaveBeenCalledWith(true));
  });

  it('reuses the original request key after an ambiguous network failure', async () => {
    const generate = vi.spyOn(api.highlights, 'generate').mockRejectedValueOnce(new TypeError('연결 끊김')).mockResolvedValueOnce(ready);
    const view = workspace();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '하이라이트 삽화 생성' });
    vi.mocked(api.highlights.get).mockResolvedValue({ ...empty, configured: false });
    await user.click(screen.getByRole('button', { name: '하이라이트 삽화 생성' }));
    await user.click(await screen.findByRole('button', { name: '같은 요청 다시 확인' }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1]).toEqual(generate.mock.calls[0]);
    expect(view.source).toHaveBeenCalledOnce();
  });

  it('retries a failed download without saving or starting a different generation', async () => {
    const generate = vi.spyOn(api.highlights, 'generate').mockResolvedValue(ready);
    const captureSource = vi.fn();
    workspace({ captureSource, state: { ...empty, configured: false, generation: {
      id: 'job', status: 'FAILED', error: '이미지 저장 실패', retryableDownload: true,
      idempotencyKey: 'paid-request', expectedRevision: 2,
    } } });
    await userEvent.setup().click(await screen.findByRole('button', { name: '이미지 저장 다시 시도' }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith('project', 'episode', 2, 'paid-request'));
    expect(captureSource).not.toHaveBeenCalled();
  });

  it('discovers a running generation after reload and polls without another POST', async () => {
    vi.useFakeTimers();
    const generate = vi.spyOn(api.highlights, 'generate');
    workspace({ state: { ...ready, generation: {
      id: 'job', status: 'RUNNING', error: null, retryableDownload: false,
      idempotencyKey: 'in-progress', expectedRevision: 3,
    } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: '삽화 생성 중' })).toBeDisabled();
    vi.mocked(api.highlights.get).mockResolvedValue(ready);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(api.highlights.get).toHaveBeenCalledTimes(2);
    expect(generate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '삽화 다시 생성' })).toBeEnabled();
  });

  it('repositions the same image using the saved episode revision and preserves a stale badge', async () => {
    const content = `새 시작.\n${original}`;
    const place = vi.spyOn(api.highlights, 'place').mockResolvedValue({ ...ready, image: { ...image, anchorSourceContent: content, anchorText: '새 시작.', anchorOffset: 5 } });
    const captureSource = vi.fn().mockResolvedValue({ ...episode, content, revision: 4 });
    workspace({ state: ready, content, captureSource });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '위치 변경' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('radio', { name: /1번째 문단/ }));
    await user.click(dialog.getByRole('button', { name: '이 문단 뒤에 삽입' }));
    await waitFor(() => expect(place).toHaveBeenCalledWith('project', 'episode', {
      expectedEpisodeRevision: 4, expectedImageId: 'picture', afterParagraphId: 1,
    }));
    expect(screen.getByText('본문 변경됨')).toBeInTheDocument();
    expect(screen.getByAltText(image.altText)).toBeInTheDocument();
  });

  it('preserves the existing picture when regeneration fails', async () => {
    vi.spyOn(api.highlights, 'generate').mockResolvedValue({ ...ready, generation: {
      id: 'failed', status: 'FAILED', error: '생성 서비스 오류', retryableDownload: false,
      idempotencyKey: 'failed-request', expectedRevision: 3,
    } });
    workspace({ state: ready });
    await userEvent.setup().click(await screen.findByRole('button', { name: '삽화 다시 생성' }));
    expect(await screen.findByText('생성 서비스 오류')).toBeInTheDocument();
    expect(screen.getByAltText(image.altText)).toBeInTheDocument();
  });

  it('deletes only the selected image while retaining the manuscript in reading preview', async () => {
    const remove = vi.spyOn(api.highlights, 'remove').mockResolvedValue(empty);
    workspace({ state: ready });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '삽화 삭제' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('project', 'episode', 'picture'));
    await waitFor(() => expect(screen.queryByAltText(image.altText)).not.toBeInTheDocument());
    expect(screen.getByLabelText('회차 읽기 미리보기').textContent).toBe(original);
  });
});

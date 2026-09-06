import { useLayoutEffect, useRef, type RefObject, type TextareaHTMLAttributes } from 'react';
import type { SelectionSnapshot } from '../types';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'className'> & {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  highlight: SelectionSnapshot | null;
};

export default function StoryEditor({ textareaRef, value, highlight, ...props }: Props) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const readingPositionRef = useRef(0);
  const wasReadOnlyRef = useRef(props.readOnly);
  const visible = Boolean(highlight?.text && highlight.content === value);

  useLayoutEffect(() => {
    if ((props.readOnly || wasReadOnlyRef.current) && textareaRef.current) {
      textareaRef.current.scrollTop = readingPositionRef.current;
      readingPositionRef.current = textareaRef.current.scrollTop;
    }
    wasReadOnlyRef.current = props.readOnly;
  }, [value, props.readOnly, textareaRef]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    const sync = () => {
      // Use the text viewport so a native scrollbar cannot shift line wrapping.
      mirror.style.width = `${textarea.clientWidth}px`;
      mirror.style.height = `${textarea.clientHeight}px`;
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    textarea.addEventListener('scroll', sync, { passive: true });
    return () => {
      observer.disconnect();
      textarea.removeEventListener('scroll', sync);
    };
  }, [textareaRef, value, highlight, visible]);

  return <div className="story-editor-wrap">
    {visible && highlight ? <div ref={mirrorRef} className="story-editor story-editor-highlight" aria-hidden="true">
      {value.slice(0, highlight.start)}<mark>{value.slice(highlight.start, highlight.end)}</mark>{value.slice(highlight.end)}{'\n'}
    </div> : null}
    <textarea {...props} ref={textareaRef} value={value} className="story-editor" onScroll={(event) => {
      readingPositionRef.current = event.currentTarget.scrollTop;
      props.onScroll?.(event);
    }} />
  </div>;
}

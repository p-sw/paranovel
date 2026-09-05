import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { AlertCircle, LoaderCircle, X } from 'lucide-react';
import { cx } from '../lib';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  busy,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cx('button', `button-${variant}`, `button-${size}`, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...props }: ButtonProps & { label: string }) {
  return (
    <button className={cx('icon-button', className)} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Spinner({ label = '불러오는 중' }: { label?: string }) {
  return (
    <div className="state-box" role="status">
      <LoaderCircle className="size-6 animate-spin text-plum-600" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-box" role="alert">
      <AlertCircle className="size-7 text-red-600" aria-hidden="true" />
      <div>
        <p className="font-semibold text-ink">문제가 생겼어요</p>
        <p className="mt-1 text-sm text-muted">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          다시 시도
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'plum' | 'sage' | 'warning' | 'danger';
}) {
  return <span className={cx('badge', `badge-${tone}`, className)} {...props} />;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
  bodyHeader,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  bodyHeader?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={cx('sheet-content', wide && 'sheet-wide')}>
          <header className="sheet-header">
            <div className="min-w-0">
              <Dialog.Title className="sheet-title">{title}</Dialog.Title>
              {description ? <Dialog.Description className="sheet-description">{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close asChild>
              <IconButton label="닫기" className="shrink-0">
                <X className="size-5" aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </header>
          {bodyHeader ? <div className="sheet-body-header">{bodyHeader}</div> : null}
          <div className="sheet-body">{children}</div>
          {footer ? <footer className="sheet-footer">{footer}</footer> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '삭제',
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="alert-content">
          <AlertDialog.Title className="sheet-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted">
            {description}
          </AlertDialog.Description>
          <div className="action-row mt-6">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">취소</Button>
            </AlertDialog.Cancel>
            <Button variant="danger" busy={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-sm text-red-700">{children}</p>;
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="card-grid" aria-label="목록을 불러오는 중">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="card min-h-40 animate-pulse">
          <div className="h-4 w-24 rounded bg-line/60" />
          <div className="mt-5 h-6 w-3/4 rounded bg-line/70" />
          <div className="mt-3 h-4 w-full rounded bg-line/50" />
          <div className="mt-2 h-4 w-2/3 rounded bg-line/50" />
        </div>
      ))}
    </div>
  );
}

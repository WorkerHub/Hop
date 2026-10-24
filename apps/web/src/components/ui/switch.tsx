import { cn } from '@/lib/utils';

// Minimal Switch without Radix (to avoid extra dep)
export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-(--duration-normal) ease-(--ease-in-out) focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background shadow-xs transition-transform duration-(--duration-normal) ease-(--ease-in-out)',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}

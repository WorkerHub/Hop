import { Input } from '@/components/ui/input';

export function OtpInput({
  value,
  onChange,
  autoFocus,
  id,
  placeholder = '000000',
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  id?: string;
  placeholder?: string;
}) {
  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      className="font-mono text-center text-body-lg tracking-caps"
    />
  );
}

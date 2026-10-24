import { Card } from '@/components/ui/card';

export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm animate-enter">{children}</Card>
    </div>
  );
}

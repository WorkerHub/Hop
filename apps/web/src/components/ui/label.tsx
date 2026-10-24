import * as React from 'react';
import { cn } from '@/lib/utils';

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, htmlFor, ...props }, ref) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: This is a reusable wrapper component; concrete usage provides control association.
  <label
    ref={ref}
    htmlFor={htmlFor}
    className={cn(
      'text-body font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';

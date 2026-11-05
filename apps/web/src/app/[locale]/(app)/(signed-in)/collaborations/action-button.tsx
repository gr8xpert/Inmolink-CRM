'use client';

import { Button } from '@inmolink/ui';
import { useFormStatus } from 'react-dom';

/**
 * The submit button of a collaboration form (S17-F56): off while the action runs, so a double click sends one answer, and
 * with `confirm` it asks first (decline, cancel). A plain button in a server-rendered form, so the keyboard just works.
 */
export function ActionButton(props: {
  label: string;
  confirm?: string;
  name?: string;
  value?: string;
  variant?: 'default' | 'outline';
}) {
  const { pending } = useFormStatus();
  const { confirm } = props;
  return (
    <Button
      type="submit"
      size="sm"
      variant={props.variant ?? 'outline'}
      disabled={pending}
      name={props.name}
      value={props.value}
      onClick={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
    >
      {props.label}
    </Button>
  );
}

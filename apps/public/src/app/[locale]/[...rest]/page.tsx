import { notFound } from 'next/navigation';

/** Unknown paths under a locale render the localized 404 inside the locale layout. */
export default function CatchAll(): never {
  notFound();
}
